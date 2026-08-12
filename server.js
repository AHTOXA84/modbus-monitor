/* =========================================================
   MODBUS MONITOR — веб-дашборд чтения регистров Modbus TCP
   Сервер: статика + REST API + опрос устройств Modbus.
   Слушает 0.0.0.0, чтобы было доступно из локальной сети.
   ========================================================= */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ModbusRTU = require('modbus-serial');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const CONFIG_FILE = path.join(ROOT, 'data', 'config.json');
const LOG_FILE = path.join(ROOT, 'data', 'event-log.json');

const SIM_PORT = 5020;
const SIM_HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/* ---------- Конфигурация ---------- */
try { fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); } catch { /* read-only */ }
let config = loadConfig();
const deviceState = new Map(); // deviceId -> { client, polling, lastOk, lastError }

function loadConfig() {
  const def = {
    pollIntervalMs: 2000,
    timeoutMs: 2000,
    simulator: { enabled: true, port: SIM_PORT },
    logging: { enabled: true, minIntervalMs: 5000, maxEntries: 1000 },
    devices: defaultDemoDevices()
  };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const cfg = Object.assign(def, raw);
    if (!cfg.logging || typeof cfg.logging !== 'object') cfg.logging = def.logging;
    return cfg;
  } catch {
    return def;
  }
}

function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); }
  catch (e) { console.error('  Не удалось сохранить конфиг:', e.message); }
}

function defaultDemoDevices() {
  return [
    {
      id: 'sim-uzv',
      name: 'Симулятор УЗВ (демо)',
      host: SIM_HOST,
      port: SIM_PORT,
      unitId: 1,
      registers: [
        { id: 'temp',  name: 'Температура воды', address: 0, type: 'holding', dataType: 'float',  byteOrder: 'ABCD', scale: 1, unit: '°C',   decimals: 1 },
        { id: 'pres',  name: 'Давление',        address: 2, type: 'holding', dataType: 'float',  byteOrder: 'ABCD', scale: 1, unit: 'бар', decimals: 2 },
        { id: 'pump',  name: 'Насос',           address: 4, type: 'holding', dataType: 'uint16', scale: 1, unit: '',    decimals: 0 },
        { id: 'rpm',   name: 'Обороты насоса',  address: 5, type: 'holding', dataType: 'uint16', scale: 1, unit: 'об/мин', decimals: 0 },
        { id: 'level', name: 'Уровень бассейна', address: 6, type: 'holding', dataType: 'uint16', scale: 1, unit: '%',    decimals: 0 },
        { id: 'ph',    name: 'pH воды',         address: 7, type: 'holding', dataType: 'float',  byteOrder: 'ABCD', scale: 1, unit: '',    decimals: 2 },
        { id: 'o2',    name: 'Кислород',        address: 9, type: 'holding', dataType: 'float',  byteOrder: 'ABCD', scale: 1, unit: 'мг/л', decimals: 1 },
        { id: 'valve', name: 'Клапан аварийный', address: 11, type: 'coil', dataType: 'bool', scale: 1, unit: '', decimals: 0 }
      ]
    }
  ];
}

/* ---------- Встроенный симулятор Modbus-устройства ---------- */
function startSimulator() {
  if (!config.simulator || !config.simulator.enabled) return;

  const sim = {
    temp: 19.0, pressure: 2.4, pumpOn: 1, rpm: 1450,
    level: 63, ph: 7.3, o2: 8.6, valve: 0
  };

  setInterval(() => {
    const t = Date.now() / 1000;
    sim.temp = 19 + Math.sin(t / 8) * 1.5;
    sim.pressure = 2.4 + Math.sin(t / 12) * 0.3;
    sim.rpm = sim.pumpOn ? 1450 + Math.round(Math.sin(t / 5) * 40) : 0;
    sim.level = 63 + Math.round(Math.sin(t / 20) * 4);
    sim.ph = 7.3 + Math.sin(t / 15) * 0.15;
    sim.o2 = 8.6 + Math.sin(t / 10) * 0.4;
  }, 1000);

  function toWords32(value) {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(value, 0);
    return { hi: buf.readUInt16BE(0), lo: buf.readUInt16BE(2) };
  }

  function regFor(addr, type, unitID) {
    const f = toWords32(sim.temp);
    const p = toWords32(sim.pressure);
    const ph = toWords32(sim.ph);
    const o2 = toWords32(sim.o2);
    const holding = {
      0: f.hi, 1: f.lo,
      2: p.hi, 3: p.lo,
      4: sim.pumpOn, 5: sim.rpm, 6: sim.level,
      7: ph.hi, 8: ph.lo,
      9: o2.hi, 10: o2.lo
    };
    const input = { 0: Math.round(sim.temp * 10), 1: sim.rpm, 2: sim.level };
    const coils = { 0: sim.valve };
    const discretes = { 0: sim.pumpOn };

    if (type === 'holding') return holding[addr];
    if (type === 'input') return input[addr];
    if (type === 'coil') return coils[addr];
    if (type === 'discrete') return discretes[addr];
    return null;
  }

  const ServerTCP = require('modbus-serial/servers/servertcp');
  const vector = {
    getHoldingRegister: (addr, unitID) => regFor(addr, 'holding', unitID),
    getInputRegister: (addr, unitID) => regFor(addr, 'input', unitID),
    getCoil: (addr, unitID) => regFor(addr, 'coil', unitID),
    getDiscreteInput: (addr, unitID) => regFor(addr, 'discrete', unitID)
  };

  const server = new ServerTCP(vector, {
    host: SIM_HOST,
    port: config.simulator.port || SIM_PORT,
    debug: false,
    unitID: 1
  });

  server.on('socketError', (err) => console.error('  [симулятор] socketError:', err.message));
  server.on('serverError', (err) => {
    if (err && err.code !== 'EADDRINUSE') console.error('  [симулятор] serverError:', err.message);
  });
  console.log(`  Симулятор Modbus TCP: ${SIM_HOST}:${config.simulator.port || SIM_PORT}`);
}

/* ---------- Работа с Modbus ---------- */
function wordsSwap(buf) {
  // byteOrder CDAB: сначала младшее слово, потом старшее
  const hi = (buf[2] << 8) | buf[3];
  const lo = (buf[0] << 8) | buf[1];
  return (hi << 16) | lo;
}

function decodeRegister(reg, buf, offset) {
  const d = reg.dataType || 'uint16';
  switch (d) {
    case 'uint16': return buf.readUInt16BE(offset);
    case 'int16':  return buf.readInt16BE(offset);
    case 'uint32': return reg.byteOrder === 'CDAB' ? wordsSwap(buf.subarray(offset, offset + 4)) : buf.readUInt32BE(offset);
    case 'int32': {
      const u = reg.byteOrder === 'CDAB' ? wordsSwap(buf.subarray(offset, offset + 4)) : buf.readUInt32BE(offset);
      return u | 0;
    }
    case 'float': {
      const b = buf.subarray(offset, offset + 4);
      if (reg.byteOrder === 'CDAB') {
        const s = Buffer.from([b[2], b[3], b[0], b[1]]);
        return s.readFloatBE(0);
      }
      return b.readFloatBE(0);
    }
    case 'bool': return buf.readUInt8(offset) ? 1 : 0;
    default: return buf.readUInt16BE(offset);
  }
}

function regWidth(reg) {
  return ['uint32', 'int32', 'float'].includes(reg.dataType) ? 2 : 1;
}

function buildGroups(registers) {
  const byType = {};
  for (const r of registers) {
    (byType[r.type || 'holding'] = byType[r.type || 'holding'] || []).push(r);
  }
  const groups = [];
  for (const type of Object.keys(byType)) {
    const sorted = byType[type].slice().sort((a, b) => a.address - b.address);
    let cur = null;
    for (const r of sorted) {
      if (!cur) {
        cur = { type, start: r.address, end: r.address + regWidth(r), regs: [] };
        groups.push(cur);
      } else if (r.address <= cur.end) {
        cur.end = Math.max(cur.end, r.address + regWidth(r));
      } else {
        cur = { type, start: r.address, end: r.address + regWidth(r), regs: [] };
        groups.push(cur);
      }
      cur.regs.push(r);
    }
  }
  return groups;
}

function toBuffer(arr16) {
  const buf = Buffer.alloc(arr16.length * 2);
  arr16.forEach((v, i) => buf.writeUInt16BE(v, i * 2));
  return buf;
}

function toByteBuffer(bools) {
  return Buffer.from(bools.map(v => (v ? 1 : 0)));
}

async function readGroup(client, group) {
  const length = group.end - group.start;
  switch (group.type) {
    case 'holding':
      return toBuffer((await client.readHoldingRegisters(group.start, length)).data);
    case 'input':
      return toBuffer((await client.readInputRegisters(group.start, length)).data);
    case 'coil':
      return toByteBuffer((await client.readCoils(group.start, length)).data);
    case 'discrete':
      return toByteBuffer((await client.readDiscreteInputs(group.start, length)).data);
    default:
      throw new Error('Неизвестный тип регистра: ' + group.type);
  }
}

function getClient(dev) {
  let st = deviceState.get(dev.id);
  if (!st) {
    st = { client: new ModbusRTU(), polling: false, lastOk: 0, lastError: null };
    deviceState.set(dev.id, st);
  }
  return st;
}

/* ---------- Журнал событий ---------- */
let eventLog = loadLog();
const logThrottle = new Map(); // 'devId:regId' -> { last, lastVal }
let logDirty = false;
let logFlushTimer = null;

function loadLog() {
  try {
    const arr = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function pushLog(entry) {
  eventLog.push(entry);
  const max = Math.max(100, Number((config.logging || {}).maxEntries) || 1000);
  if (eventLog.length > max) eventLog.splice(0, eventLog.length - max);
  logDirty = true;
  if (!logFlushTimer) logFlushTimer = setTimeout(flushLog, 1500);
}

function flushLog() {
  logFlushTimer = null;
  if (!logDirty) return;
  logDirty = false;
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(eventLog), 'utf8'); } catch { /* нет доступа */ }
}

// Событие сервера (старт/остановка) — пишется всегда, независимо от logging.enabled.
function logServerEvent(action, extra) {
  const entry = { type: 'server', action, t: Date.now() };
  if (extra) Object.assign(entry, extra);
  eventLog.push(entry);
  const max = Math.max(100, Number((config.logging || {}).maxEntries) || 1000);
  if (eventLog.length > max) eventLog.splice(0, eventLog.length - max);
  logDirty = true;
  flushLog();
}

function clearLog() {
  eventLog = [];
  logThrottle.clear();
  logDirty = true;
  flushLog();
}

// Запись только при изменении значения и не чаще, чем minIntervalMs на регистр.
function maybeLogChange(dev, reg, value, raw) {
  const L = config.logging || {};
  if (!L.enabled) return;
  const minMs = Math.max(0, Number(L.minIntervalMs) || 0);
  const key = dev.id + ':' + reg.id;
  let s = logThrottle.get(key);
  if (!s) { s = { last: 0, lastVal: undefined }; logThrottle.set(key, s); }
  // Первое чтение — базовая точка, в журнал не пишем.
  if (s.lastVal === undefined) { s.lastVal = value; s.last = Date.now(); return; }
  if (value === s.lastVal) return;
  const now = Date.now();
  if (now - s.last < minMs) return;
  s.last = now;
  s.lastVal = value;
  pushLog({
    t: now,
    deviceId: dev.id,
    deviceName: dev.name,
    regId: reg.id,
    regName: reg.name,
    unit: reg.unit || '',
    decimals: reg.decimals == null ? 0 : reg.decimals,
    value,
    raw,
    dt: reg.dataType || 'uint16'
  });
}

async function pollDevice(dev) {
  const st = getClient(dev);
  if (st.polling) return;
  st.polling = true;

  try {
    const client = st.client;
    if (!client.isOpen) await client.connectTCP(dev.host, { port: dev.port });
    client.setID(dev.unitId);
    client.setTimeout(config.timeoutMs || 2000);

    const groups = buildGroups(dev.registers || []);
    const byId = {};
    for (const reg of dev.registers || []) byId[reg.id] = reg;

    for (const g of groups) {
      const data = await readGroup(client, g);
      for (const reg of g.regs) {
        const raw = decodeRegister(reg, data, (reg.address - g.start) * 2);
        const scale = reg.scale == null ? 1 : reg.scale;
        const value = raw * scale;
        maybeLogChange(dev, reg, value, raw);
        byId[reg.id]._value = value;
        byId[reg.id]._raw = raw;
      }
    }

    st.lastOk = Date.now();
    st.lastError = null;
  } catch (err) {
    st.lastError = err.message || String(err);
    try { st.client.close(() => {}); } catch { /* ignore */ }
    st.client = new ModbusRTU();
  } finally {
    st.polling = false;
  }
}

function buildStatus() {
  const devices = config.devices.map(dev => {
    const st = deviceState.get(dev.id);
    const regs = dev.registers || [];
    const values = regs.map(r => {
      const has = r._value !== undefined;
      const decimals = r.decimals == null ? 0 : r.decimals;
      return {
        id: r.id,
        name: r.name,
        unit: r.unit || '',
        decimals,
        raw: has ? r._raw : null,
        value: has ? Number(r._value.toFixed(Math.min(decimals, 6))) : null,
        updatedAt: has && st ? st.lastOk : null
      };
    });
    return {
      id: dev.id,
      name: dev.name,
      host: dev.host,
      port: dev.port,
      unitId: dev.unitId,
      online: !!(st && st.lastError === null && st.lastOk > 0),
      lastUpdate: st ? st.lastOk : null,
      error: st ? st.lastError : null,
      values
    };
  });
  return { generatedAt: Date.now(), devices };
}

/* ---------- HTTP-хелперы ---------- */
function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let filePath = path.normalize(path.join(PUBLIC, pathname));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404 — не найдено</h1>');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

function localAddresses() {
  const list = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) list.push(i.address);
    }
  }
  return list;
}

async function testRead(body) {
  const host = String(body.host || '').trim();
  const port = Number(body.port) || 502;
  const unitId = Number(body.unitId) || 1;
  const address = Number(body.address) || 0;
  const type = body.type || 'holding';
  const count = Math.min(Math.max(Number(body.count) || 2, 1), 16);
  if (!host) throw new Error('Не указан host');

  const client = new ModbusRTU();
  try {
    await client.connectTCP(host, { port });
    client.setID(unitId);
    client.setTimeout(3000);
    let data;
    if (type === 'holding') data = (await client.readHoldingRegisters(address, count)).data;
    else if (type === 'input') data = (await client.readInputRegisters(address, count)).data;
    else if (type === 'coil') data = (await client.readCoils(address, count)).data;
    else data = (await client.readDiscreteInputs(address, count)).data;
    return { ok: true, values: data };
  } finally {
    try { client.close(() => {}); } catch { /* ignore */ }
  }
}

/* ---------- API ---------- */
async function handleApi(req, res, url) {
  const method = req.method;

  if (url.pathname === '/api/status' && method === 'GET') {
    return sendJson(res, 200, buildStatus());
  }

  if (url.pathname === '/api/config' && method === 'GET') {
    return sendJson(res, 200, config);
  }

  if (url.pathname === '/api/shutdown' && method === 'POST') {
    const remote = req.socket.remoteAddress;
    const isLocal = !remote || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!isLocal) return sendJson(res, 403, { error: 'Остановка разрешена только с этого компьютера' });
    logServerEvent('stop');
    sendJson(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 150);
    return;
  }

  if (url.pathname === '/api/config' && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'Некорректный JSON' }); }
    if (!Array.isArray(body.devices)) return sendJson(res, 400, { error: 'Поле devices должно быть массивом' });
    config.devices = body.devices;
    if (body.pollIntervalMs) config.pollIntervalMs = Number(body.pollIntervalMs) || 2000;
    if (body.timeoutMs) config.timeoutMs = Number(body.timeoutMs) || 2000;
    if (body.simulator && typeof body.simulator.enabled === 'boolean') config.simulator.enabled = body.simulator.enabled;
    if (body.logging && typeof body.logging === 'object') {
      const lg = config.logging || {};
      config.logging = {
        enabled: typeof body.logging.enabled === 'boolean' ? body.logging.enabled : lg.enabled !== false,
        minIntervalMs: Math.max(0, Number(body.logging.minIntervalMs) || 0),
        maxEntries: Math.max(100, Number(body.logging.maxEntries) || 1000)
      };
    }
    deviceState.clear();
    saveConfig(config);
    return sendJson(res, 200, { ok: true, config });
  }

  if (url.pathname === '/api/log' && method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 2000);
    const device = url.searchParams.get('device');
    const reg = url.searchParams.get('reg');
    const fmt = url.searchParams.get('format');
    let entries = eventLog;
    if (device) entries = entries.filter(e => e.deviceId === device);
    if (reg) entries = entries.filter(e => e.regId === reg);

    if (fmt === 'csv') {
      const rows = entries.slice().sort((a, b) => a.t - b.t);
      let csv = 'time,time_ms,device,register,value,raw,unit\r\n';
      for (const e of rows) {
        if (e.type === 'server') continue;
        csv += `${new Date(e.t).toISOString()},${e.t},"${String(e.deviceName).replace(/"/g, '""')}","${String(e.regName).replace(/"/g, '""')}",${e.value},${e.raw},"${String(e.unit).replace(/"/g, '""')}"\r\n`;
      }
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="modbus-log.csv"'
      });
      res.end('\uFEFF' + csv);
      return;
    }

    const list = entries.slice(-limit).reverse();
    return sendJson(res, 200, { entries: list, total: entries.length, settings: config.logging || {} });
  }

  if (url.pathname === '/api/log' && method === 'DELETE') {
    clearLog();
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/api/net' && method === 'GET') {
    return sendJson(res, 200, { port: PORT, addresses: localAddresses() });
  }

  if (url.pathname === '/api/test' && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'Некорректный JSON' }); }
    try {
      return sendJson(res, 200, await testRead(body));
    } catch (err) {
      return sendJson(res, 502, { error: err.message || 'Не удалось прочитать' });
    }
  }

  return sendJson(res, 404, { error: 'Not found' });
}

/* ---------- Опрос по расписанию ---------- */
setInterval(() => {
  for (const dev of config.devices) pollDevice(dev);
}, config.pollIntervalMs || 2000);

/* ---------- HTTP-сервер ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400); res.end(); return; }

  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, url);
    serveStatic(req, res, pathname);
  } catch (err) {
    sendJson(res, 500, { error: 'Ошибка сервера' });
  }
});

if (config.simulator && config.simulator.enabled) startSimulator();

process.on('SIGINT', () => { logServerEvent('stop'); process.exit(0); });
process.on('SIGTERM', () => { logServerEvent('stop'); process.exit(0); });

function openBrowser(url) {
  try {
    const { exec } = require('child_process');
    const cmd = process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
    exec(cmd, () => {});
  } catch { /* браузер не открыть */ }
}

function isOurServer() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/api/config', timeout: 1500 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            resolve(!!j && (Array.isArray(j.devices) || typeof j.pollIntervalMs === 'number'));
          } catch { resolve(false); }
        });
      });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n  Порт ${PORT} уже занят.`);
    isOurServer().then((ours) => {
      if (ours) {
        console.log('  Modbus Monitor уже запущен. Открываю существующую панель...');
        openBrowser(`http://127.0.0.1:${PORT}/`);
        process.exit(0);
      }
      console.error(`  Порт ${PORT} занят другим приложением.`);
      console.error('  Закройте программу, использующую этот порт, либо задайте другой:');
      console.error('  set PORT=3100 && ModbusMonitor.exe');
      process.exit(1);
    });
    return;
  }
  console.error('  Ошибка сервера:', err && err.message ? err.message : err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('================================================');
  console.log('  MODBUS MONITOR — дашборд Modbus TCP');
  console.log('------------------------------------------------');
  const addrs = localAddresses();
  console.log(`  Локально:  http://127.0.0.1:${PORT}/`);
  for (const a of addrs) console.log(`  В сети:    http://${a}:${PORT}/`);
  console.log('------------------------------------------------');
  console.log(`  Устройств: ${config.devices.length}`);
  console.log(`  Интервал:  ${config.pollIntervalMs || 2000} мс`);
  if (config.simulator && config.simulator.enabled) {
    console.log(`  Демо-симулятор Modbus TCP запущен на ${SIM_HOST}:${config.simulator.port || SIM_PORT}`);
  }
  console.log('================================================');

  // Отмечаем старт; если перед этим не было записи «остановлен» — прошлый сеанс завершился нештатно.
  const lastEntry = eventLog[eventLog.length - 1];
  if (lastEntry && lastEntry.type === 'server' && lastEntry.action === 'start') {
    logServerEvent('start', { abnormal: true, since: lastEntry.t });
  } else {
    logServerEvent('start');
  }
});
