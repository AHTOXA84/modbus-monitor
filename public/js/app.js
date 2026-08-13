/* ============ MODBUS MONITOR — фронтенд ============ */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const state = {
    config: null,
    lastStatus: null,
    cardPos: {},          // devId -> {x, y} (позиции окон)
    dragging: false,      // идёт перетаскивание (пауза обновлений)
    editingName: false,   // редактируется название
    pendingStatus: null,  // статус, накопленный во время паузы
    alarms: { config: null, active: [] },
    theme: 'emerald'
  };

  const STORAGE_POS = 'mmCardPos';
  const STORAGE_THEME = 'mmTheme';
  const STORAGE_BRAND = 'mmBrand';
  const STORAGE_JVIEW = 'mmJournalView';
  const STORAGE_JDEVICE = 'mmJournalDevice';
  const STORAGE_JREG = 'mmJournalReg';
  const STORAGE_JLIMIT = 'mmJournalLimit';
  const STORAGE_JAUTO = 'mmJournalAuto';
  const STORAGE_SAUTO = 'mmStatusAuto';
  const STORAGE_SINTERVAL = 'mmStatusInterval';
  const GRID = 12; // шаг невидимой сетки (px)

  const journal = {
    mode: 'list',
    device: '',
    reg: '',
    limit: 200,
    auto: true,
    entries: [],
    prevKeys: new Set(),
    newKeys: new Set(),
    hiddenSeries: new Set(),
    settings: null
  };

  const statusAuto = {
    enabled: true,
    intervalMs: 3000
  };

  const UI = {
    netAddr: $('#netAddr'),
    connDot: $('#connDot'),
    connText: $('#connText'),
    canvas: $('#devicesCanvas'),
    empty: $('#emptyMsg'),
    themeSelect: $('#themeSelect'),
    themeSwatch: $('#themeSwatch'),
    statDevices: $('#statDevices'),
    statOnline: $('#statOnline'),
    statRegs: $('#statRegs'),
    statErrors: $('#statErrors'),
    statLast: $('#statLast'),
    configPanel: $('#configPanel'),
    deviceList: $('#deviceList'),
    saveNote: $('#saveNote'),
    testResult: $('#testResult'),
    testForm: $('#testForm'),
    brandTitle: $('#brandTitle'),
    brandSub: $('#brandSub'),
    brandTitleEdit: $('#brandTitleEdit'),
    brandSubEdit: $('#brandSubEdit'),
    journalPanel: $('#journalPanel'),
    journalList: $('#journalList'),
    journalGraphWrap: $('#journalGraphWrap'),
    journalGraph: $('#journalGraph'),
    journalLegend: $('#journalLegend'),
    journalEmpty: $('#journalEmpty'),
    journalMode: $('#journalMode'),
    journalDevice: $('#journalDevice'),
    journalReg: $('#journalReg'),
    journalLimit: $('#journalLimit'),
    journalAuto: $('#journalAuto'),
    statusAuto: $('#statusAuto'),
    statusInterval: $('#statusInterval'),
    logEnabled: $('#loggingEditor .l-enabled'),
    logInterval: $('#loggingEditor .l-interval'),
    logMax: $('#loggingEditor .l-max'),
    alarmBanner: $('#alarmBanner'),
    alarmBannerList: $('#alarmBannerList'),
    btnAlarmBannerGo: $('#btnAlarmBannerGo'),
    alarmsPanel: $('#alarmsPanel'),
    alarmsEnabled: $('#alarmsEnabled'),
    alarmsResend: $('#alarmsResend'),
    alarmsNote: $('#alarmsNote'),
    alarmsActiveEmpty: $('#alarmsActiveEmpty'),
    alarmsActiveList: $('#alarmsActiveList'),
    alarmsRules: $('#alarmsRules')
  };

  /* ---------- Сеть ---------- */
  async function loadNet() {
    try {
      const r = await fetch('/api/net');
      const data = await r.json();
      const addr = (data.addresses && data.addresses[0]) || '127.0.0.1';
      UI.netAddr.textContent = `http://${addr}:${data.port}/`;
    } catch {
      UI.netAddr.textContent = '—';
    }
  }

  /* ---------- Статус сервера ---------- */
  function setConn(ok, text) {
    UI.connDot.className = 'dot ' + (ok ? 'dot--ok' : 'dot--err');
    UI.connText.textContent = text;
  }

  /* ---------- Цветовые схемы ---------- */
  const THEME_SWATCH = {
    emerald: '#10b981',
    ocean: '#0ea5e9',
    sunset: '#f97316',
    amethyst: '#a855f7',
    midnight: '#94a3b8',
    light: '#34d399',
    sky: '#38bdf8',
    dawn: '#fdba74'
  };

  function applyTheme(name) {
    state.theme = THEME_SWATCH[name] ? name : 'emerald';
    document.documentElement.setAttribute('data-theme', state.theme);
    UI.themeSelect.value = state.theme;
    UI.themeSwatch.style.background = THEME_SWATCH[state.theme];
    try { localStorage.setItem(STORAGE_THEME, state.theme); } catch { /* нет доступа */ }
    if (UI.journalPanel && !UI.journalPanel.hidden && journal.mode === 'graph') renderJournalGraph();
  }

  /* ---------- Позиции окон ---------- */
  function loadPositions() {
    try {
      state.cardPos = JSON.parse(localStorage.getItem(STORAGE_POS)) || {};
    } catch {
      state.cardPos = {};
    }
  }

  function savePositions() {
    try { localStorage.setItem(STORAGE_POS, JSON.stringify(state.cardPos)); } catch { /* нет доступа */ }
  }

  function snap(v) {
    return Math.round(v / GRID) * GRID;
  }

  /* ---------- Редактирование названия ---------- */
  async function renameDevice(devId, newName) {
    newName = (newName || '').trim();
    if (!state.config || !newName) return;
    const dev = state.config.devices.find(d => d.id === devId);
    if (!dev) return;
    dev.name = newName;
    try {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          devices: state.config.devices,
          pollIntervalMs: state.config.pollIntervalMs,
          timeoutMs: state.config.timeoutMs,
          simulator: state.config.simulator
        })
      });
    } catch { /* сервер сам подтянет при следующем опросе */ }
  }

  function startRename(card, nameSpan, devId) {
    if (state.editingName) return;
    state.editingName = true;
    const old = nameSpan.textContent;
    const input = document.createElement('input');
    input.className = 'device-card__name-input';
    input.value = old;
    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      state.editingName = false;
      const value = input.value;
      input.replaceWith(nameSpan);
      nameSpan.textContent = value;
      if (save && value.trim()) {
        nameSpan.textContent = value.trim();
        renameDevice(devId, value);
      } else {
        nameSpan.textContent = old;
      }
      if (state.pendingStatus) {
        const s = state.pendingStatus;
        state.pendingStatus = null;
        renderStatus(s);
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  /* ---------- Заголовок (название и подзаголовок) ---------- */
  function loadBrand() {
    try {
      const b = JSON.parse(localStorage.getItem(STORAGE_BRAND)) || {};
      if (typeof b.title === 'string' && b.title) UI.brandTitle.textContent = b.title;
      if (typeof b.sub === 'string' && b.sub) UI.brandSub.textContent = b.sub;
    } catch { /* нет данных */ }
  }

  function saveBrand() {
    try {
      localStorage.setItem(STORAGE_BRAND, JSON.stringify({
        title: UI.brandTitle.textContent,
        sub: UI.brandSub.textContent
      }));
    } catch { /* нет доступа */ }
  }

  function editBrandText(textEl, inputClass, onSave) {
    const old = textEl.textContent;
    const input = document.createElement('input');
    input.className = inputClass;
    input.value = old;
    input.setAttribute('aria-label', 'Редактировать');
    textEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const value = input.value;
      input.replaceWith(textEl);
      textEl.textContent = save && value.trim() ? value.trim() : old;
      if (onSave) onSave();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  /* ---------- Журнал событий ---------- */
  const GRAPH_PALETTE = ['#10b981', '#0ea5e9', '#f97316', '#a855f7', '#ef4444', '#eab308', '#14b8a6', '#f43f5e', '#84cc16', '#06b6d4'];

  function loadJournalPrefs() {
    try {
      journal.mode = localStorage.getItem(STORAGE_JVIEW) || 'list';
      journal.device = localStorage.getItem(STORAGE_JDEVICE) || '';
      journal.reg = localStorage.getItem(STORAGE_JREG) || '';
      journal.limit = Number(localStorage.getItem(STORAGE_JLIMIT)) || 200;
      journal.auto = localStorage.getItem(STORAGE_JAUTO) !== '0';
    } catch { /* нет данных */ }
  }

  function saveJournalPrefs() {
    try {
      localStorage.setItem(STORAGE_JVIEW, journal.mode);
      localStorage.setItem(STORAGE_JDEVICE, journal.device);
      localStorage.setItem(STORAGE_JREG, journal.reg);
      localStorage.setItem(STORAGE_JLIMIT, String(journal.limit));
      localStorage.setItem(STORAGE_JAUTO, journal.auto ? '1' : '0');
    } catch { /* нет доступа */ }
  }

  function loadStatusPrefs() {
    try {
      statusAuto.enabled = localStorage.getItem(STORAGE_SAUTO) !== '0';
      const s = Number(localStorage.getItem(STORAGE_SINTERVAL));
      statusAuto.intervalMs = (s >= 1 && s <= 3600) ? s * 1000 : 3000;
    } catch { /* нет данных */ }
  }

  function saveStatusPrefs() {
    try {
      localStorage.setItem(STORAGE_SAUTO, statusAuto.enabled ? '1' : '0');
      localStorage.setItem(STORAGE_SINTERVAL, String(Math.round(statusAuto.intervalMs / 1000)));
    } catch { /* нет доступа */ }
  }

  function entryKey(e) {
    return e.t + ':' + e.deviceId + ':' + e.regId + ':' + e.value;
  }

  function fmtLogTime(t) {
    const d = new Date(t);
    const p = n => String(n).padStart(2, '0');
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + String(d.getFullYear()).slice(2) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function logValueText(e) {
    if (e.dt === 'bool') return e.value ? 'вкл' : 'выкл';
    const s = Number(e.value).toFixed(Math.min(e.decimals || 0, 6));
    return e.unit ? s + ' ' + e.unit : s;
  }

  function serverEventText(e) {
    if (e.action === 'stop') return 'Сервер остановлен';
    if (e.action === 'start') {
      if (e.abnormal) return 'Сервер запущен · прошлый сеанс завершён нештатно (запускался ' + fmtLogTime(e.since) + ')';
      return 'Сервер запущен';
    }
    return 'Событие сервера';
  }

  async function loadJournal() {
    const q = new URLSearchParams({ limit: String(journal.limit) });
    if (journal.device) q.set('device', journal.device);
    if (journal.reg) q.set('reg', journal.reg);
    try {
      const r = await fetch('/api/log?' + q, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      journal.entries = data.entries || [];
      journal.settings = data.settings || {};
      const keys = new Set(journal.entries.map(entryKey));
      const fresh = new Set();
      if (journal.prevKeys.size > 0) {
        for (const e of journal.entries) if (!journal.prevKeys.has(entryKey(e))) fresh.add(entryKey(e));
      }
      journal.prevKeys = keys;
      journal.newKeys = fresh;
      UI.journalEmpty.hidden = journal.entries.length > 0;
      renderJournalModeUI();
    } catch { /* сервер недоступен */ }
  }

  function renderJournalModeUI() {
    UI.journalMode.querySelectorAll('.segmented__btn').forEach(b => b.classList.toggle('is-active', b.dataset.mode === journal.mode));
    UI.journalList.hidden = journal.mode !== 'list';
    UI.journalGraphWrap.hidden = journal.mode !== 'graph';
    if (journal.mode === 'list') renderJournalList();
    else renderJournalGraph();
  }

  function renderJournalList() {
    if (!journal.entries.length) { UI.journalList.innerHTML = ''; return; }
    const tbl = el('table', 'journal__table');
    const thead = el('thead');
    const hr = el('tr');
    ['Время', 'Устройство', 'Регистр', 'Значение'].forEach(h => hr.appendChild(el('th', null, h)));
    thead.appendChild(hr);
    tbl.appendChild(thead);
    const tbody = el('tbody');
    for (const e of journal.entries) {
      if (e.type === 'server') {
        const tr = el('tr', 'journal__row--server' + (e.abnormal ? ' journal__row--server--abnormal' : ''));
        const td = el('td', null, fmtLogTime(e.t) + ' — ' + serverEventText(e));
        td.colSpan = 4;
        tr.appendChild(td);
        tbody.appendChild(tr);
        continue;
      }
      const tr = el('tr');
      if (journal.newKeys.has(entryKey(e))) tr.classList.add('journal__row--new');
      tr.appendChild(el('td', 'journal__time', fmtLogTime(e.t)));
      tr.appendChild(el('td', null, e.deviceName || e.deviceId));
      tr.appendChild(el('td', null, e.regName || e.regId));
      tr.appendChild(el('td', 'journal__val', logValueText(e)));
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    UI.journalList.innerHTML = '';
    UI.journalList.appendChild(tbl);
  }

  function renderJournalLegend(seriesMap) {
    UI.journalLegend.innerHTML = '';
    for (const s of seriesMap.values()) {
      const item = el('span', 'journal-legend__item' + (journal.hiddenSeries.has(s.key) ? ' journal-legend__item--off' : ''));
      const sw = el('span', 'sw');
      sw.style.background = GRAPH_PALETTE[s.idx % GRAPH_PALETTE.length];
      item.appendChild(sw);
      const last = s.pts[s.pts.length - 1];
      const lastTxt = last ? (fmtAxis(last.v) + (s.unit ? ' ' + s.unit : '')) : '';
      item.appendChild(document.createTextNode(s.label + (lastTxt ? ' — ' + lastTxt : '')));
      item.addEventListener('click', () => {
        if (journal.hiddenSeries.has(s.key)) journal.hiddenSeries.delete(s.key);
        else journal.hiddenSeries.add(s.key);
        renderJournalGraph();
      });
      UI.journalLegend.appendChild(item);
    }
  }

  function getCSSVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function fmtAxis(v) {
    const abs = Math.abs(v);
    const s = abs >= 100 ? v.toFixed(0) : (abs >= 10 ? v.toFixed(1) : v.toFixed(2));
    return s.replace(/\.?0+$/, '');
  }

  function fmtClock(t) {
    const d = new Date(t);
    const p = n => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function renderJournalGraph() {
    const canvas = UI.journalGraph;
    const wrap = UI.journalGraphWrap;
    const entries = journal.entries.slice().sort((a, b) => a.t - b.t);

    const seriesMap = new Map();
    for (const e of entries) {
      if (e.type === 'server') continue;
      const key = e.deviceId + '::' + e.regId;
      if (!seriesMap.has(key)) {
        seriesMap.set(key, {
          key,
          idx: seriesMap.size,
          label: (e.deviceName || e.deviceId) + ' · ' + (e.regName || e.regId),
          unit: e.unit,
          decimals: e.decimals,
          pts: []
        });
      }
      seriesMap.get(key).pts.push({ t: e.t, v: e.value });
    }
    renderJournalLegend(seriesMap);

    const w = wrap.clientWidth || 800;
    const h = 380;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const visible = [...seriesMap.values()].filter(s => !journal.hiddenSeries.has(s.key));
    if (!visible.length) {
      ctx.fillStyle = getCSSVar('--muted');
      ctx.font = '13px ' + getCSSVar('--sans');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Нет отображаемых рядов', w / 2, h / 2);
      return;
    }

    const padL = 58, padR = 18, padT = 16, padB = 34;
    const pw = w - padL - padR, ph = h - padT - padB;
    if (pw <= 0 || ph <= 0) return;

    let t0 = Infinity, t1 = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const s of visible) for (const p of s.pts) {
      t0 = Math.min(t0, p.t); t1 = Math.max(t1, p.t);
      ymin = Math.min(ymin, p.v); ymax = Math.max(ymax, p.v);
    }
    if (t0 === Infinity) return;
    if (t1 - t0 < 1000) t1 = t0 + 1000;
    const span = ymax - ymin;
    if (span === 0) { ymin -= 1; ymax += 1; }
    else { ymin -= span * 0.08; ymax += span * 0.08; }

    const grid = getCSSVar('--border');
    const muted = getCSSVar('--muted');

    // Сетка и подписи
    ctx.font = '11px ' + getCSSVar('--mono');
    ctx.lineWidth = 1;
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const v = ymin + (ymax - ymin) * i / yTicks;
      const y = padT + ph - ph * i / yTicks;
      ctx.strokeStyle = grid;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillStyle = muted;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(fmtAxis(v), padL - 6, y);
    }
    const xTicks = Math.min(6, Math.max(2, Math.floor(pw / 110)));
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let i = 0; i <= xTicks; i++) {
      const tt = t0 + (t1 - t0) * i / xTicks;
      const x = padL + pw * i / xTicks;
      ctx.strokeStyle = grid;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke();
      ctx.fillStyle = muted;
      ctx.fillText(fmtClock(tt), x, padT + ph + 8);
    }

    const yOf = v => padT + ph - (v - ymin) / (ymax - ymin) * ph;
    const xOf = t => padL + (t - t0) / (t1 - t0) * pw;
    for (const s of visible) {
      ctx.strokeStyle = GRAPH_PALETTE[s.idx % GRAPH_PALETTE.length];
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      s.pts.forEach((p, i) => {
        const x = xOf(p.t), y = yOf(p.v);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }

  function fillJournalDeviceFilter() {
    const cur = journal.device;
    UI.journalDevice.innerHTML = '';
    const all = document.createElement('option');
    all.value = ''; all.textContent = 'Все устройства';
    UI.journalDevice.appendChild(all);
    (state.config ? state.config.devices : []).forEach(d => {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.name || d.id;
      UI.journalDevice.appendChild(o);
    });
    if (cur && [...UI.journalDevice.options].some(o => o.value === cur)) {
      UI.journalDevice.value = cur;
    } else {
      journal.device = '';
      UI.journalDevice.value = '';
    }
    fillJournalRegFilter();
  }

  function fillJournalRegFilter() {
    UI.journalReg.innerHTML = '';
    const all = document.createElement('option');
    all.value = ''; all.textContent = 'Все регистры';
    UI.journalReg.appendChild(all);

    const dev = state.config ? state.config.devices.find(d => d.id === journal.device) : null;
    const hasRegs = !!(dev && (dev.registers || []).length);
    UI.journalReg.disabled = !hasRegs;
    if (hasRegs) {
      (dev.registers || []).forEach(r => {
        const o = document.createElement('option');
        o.value = r.id; o.textContent = r.name || r.id;
        UI.journalReg.appendChild(o);
      });
    }
    if (dev && journal.reg && [...UI.journalReg.options].some(o => o.value === journal.reg)) {
      UI.journalReg.value = journal.reg;
    } else {
      journal.reg = '';
      UI.journalReg.value = '';
    }
  }

  /* ---------- Форматирование ---------- */
  function fmtValue(v, decimals) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return v.toFixed(decimals || 0);
    return String(v);
  }

  function boolName(v) {
    if (v === null || v === undefined) return null;
    return v ? 'ВКЛ' : 'ВЫКЛ';
  }

  function regLabel(reg) {
    if (reg.raw !== null && reg.value !== null && reg.decimals === 0 && reg.raw === reg.value &&
        (reg.value === 0 || reg.value === 1)) {
      return boolName(reg.value);
    }
    const f = fmtValue(reg.value, reg.decimals);
    return f === null ? null : (f + (reg.unit ? ' ' + reg.unit : ''));
  }

  /* ---------- Рендер статуса ---------- */
  async function apiWrite(deviceId, registerId, value, widget) {
    if (widget) widget.disabled = true;
    const isButton = widget && widget.tagName === 'BUTTON';
    const oldText = isButton ? widget.textContent : '';
    if (isButton) widget.textContent = '…';
    try {
      const r = await fetch('/api/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, registerId, value })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
      if (isButton) {
        widget.textContent = '✓';
        setTimeout(() => { widget.textContent = oldText; }, 1200);
      }
      refreshStatus();
    } catch (e) {
      if (isButton) {
        widget.textContent = '✕';
        setTimeout(() => { widget.textContent = oldText; }, 1200);
      } else if (widget && widget.type === 'checkbox') {
        widget.checked = !widget.checked;
      }
      alert('Ошибка записи: ' + e.message);
    } finally {
      if (widget) widget.disabled = false;
    }
  }

  function controlWidget(v, devId) {
    if (!v.writable) return null;
    const isBool = v.type === 'coil' || v.dataType === 'bool';
    if (isBool) {
      const on = v.value === 1 || v.value === true;
      const lb = el('label', 'switch' + (v.value === null ? ' is-disabled' : ''));
      lb.title = 'Переключить: сейчас ' + (on ? 'ВКЛ' : 'ВЫКЛ');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = on;
      cb.disabled = v.value === null;
      cb.addEventListener('change', () => apiWrite(devId, v.id, cb.checked, cb));
      const slider = el('span', 'switch__slider');
      lb.appendChild(cb);
      lb.appendChild(slider);
      return lb;
    }
    const box = el('span', 'reg__ctrl');
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'reg__input';
    const step = Math.pow(10, -Math.max(0, Math.min(v.decimals || 0, 6)));
    inp.step = String(step);
    if (v.value !== null && isFinite(v.value)) inp.value = v.value;
    inp.disabled = v.value === null;
    const wBtn = el('button', 'btn btn--ghost btn--sm reg__write', 'Записать');
    wBtn.type = 'button';
    wBtn.addEventListener('click', () => apiWrite(devId, v.id, Number(inp.value), wBtn));
    box.appendChild(inp);
    box.appendChild(wBtn);
    return box;
  }

  function renderAlarmBanner(status) {
    const a = status.alarms || { enabled: false, active: [] };
    const list = a.active || [];
    const banner = UI.alarmBanner;
    if (!list.length) { banner.hidden = true; return; }
    banner.hidden = false;
    banner.classList.toggle('has-critical', list.some(x => x.severity === 'critical'));
    UI.alarmBannerList.innerHTML = '';
    for (const al of list) {
      const item = el('span', 'alarm-banner__item alarm-banner__item--' + (al.severity || 'warning'));
      item.textContent = (al.message || al.ruleId);
      item.title = 'Устройство ' + (al.deviceId || '') + ' · ' +
        (al.registerId || '') + ' · значение ' + al.value + ' · с ' +
        new Date(al.since).toLocaleString('ru-RU');
      UI.alarmBannerList.appendChild(item);
    }
  }

  function renderStatus(status) {
    // Во время перетаскивания/редактирования не перестраиваем DOM
    if (state.dragging || state.editingName) {
      state.pendingStatus = status;
      return;
    }
    const prev = state.lastStatus;
    state.lastStatus = status;

    let online = 0, regs = 0, errors = 0;
    UI.canvas.innerHTML = '';

    for (const dev of status.devices) {
      online += dev.online ? 1 : 0;
      regs += dev.values.length;
      if (!dev.online) errors++;

      const card = el('div', 'device-card' + (dev.online ? '' : ' device-card--off'));
      card.dataset.devId = dev.id;

      const head = el('div', 'device-card__head');
      const titleWrap = el('div');
      const title = el('div', 'device-card__title');
      const nameSpan = el('span', 'device-card__name', dev.name);
      const editBtn = el('button', 'device-card__edit', '✎');
      editBtn.type = 'button';
      editBtn.title = 'Переименовать';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startRename(card, nameSpan, dev.id);
      });
      title.appendChild(nameSpan);
      title.appendChild(editBtn);
      titleWrap.appendChild(title);
      titleWrap.appendChild(el('div', 'device-card__meta', `${dev.host}:${dev.port} · unit ${dev.unitId}`));
      head.appendChild(titleWrap);

      const badge = el('span', 'status-badge ' + (dev.online ? 'status-badge--ok' : 'status-badge--err'));
      badge.appendChild(el('span', 'dot'));
      badge.appendChild(document.createTextNode(dev.online ? 'онлайн' : 'нет связи'));
      head.appendChild(badge);
      card.appendChild(head);

      const body = el('div', 'device-card__body');
      for (const v of dev.values) {
        const row = el('div', 'reg');
        row.appendChild(el('span', 'reg__name', v.name + (v.writable ? ' ✎' : '')));

        const val = el('span', 'reg__value');
        const label = regLabel(v);
        if (label === null) {
          val.textContent = '—';
          val.classList.add('reg__value--na');
        } else {
          val.textContent = label;
          if (prev) {
            const prevVal = (prev.devices.find(d => d.id === dev.id) || {})
              .values.find(r => r.id === v.id) || {};
            if (prevVal.value !== v.value && v.updatedAt) {
              val.classList.add('reg__value--flash');
            }
          }
          if (!v.updatedAt) val.classList.add('reg__value--err');
        }
        row.appendChild(val);
        const ctrl = controlWidget(v, dev.id);
        if (ctrl) row.appendChild(ctrl);
        body.appendChild(row);
      }
      card.appendChild(body);

      if (!dev.online && dev.error) {
        card.appendChild(el('div', 'device-card__error', 'Ошибка: ' + dev.error));
      }
      if (dev.lastUpdate) {
        const t = new Date(dev.lastUpdate).toLocaleTimeString('ru-RU');
        card.appendChild(el('div', 'device-card__time', 'Обновлено: ' + t));
      }
      initDrag(card);
      UI.canvas.appendChild(card);
    }

    layoutCards();

    UI.empty.hidden = status.devices.length > 0;
    UI.statDevices.textContent = status.devices.length;
    UI.statOnline.textContent = online;
    UI.statRegs.textContent = regs;
    UI.statErrors.textContent = errors;
    UI.statLast.textContent = status.generatedAt
      ? new Date(status.generatedAt).toLocaleTimeString('ru-RU') : '—';

    renderAlarmBanner(status);
  }

  /* ---------- Перетаскивание окон с привязкой к сетке ---------- */
  function layoutCards() {
    const cards = [...UI.canvas.querySelectorAll('.device-card')];

    // Сначала естественное расположение (flex-поток), чтобы узнать позиции новых окон
    cards.forEach(c => {
      c.style.position = 'static';
      c.style.left = 'auto';
      c.style.top = 'auto';
    });
    cards.forEach(c => {
      const id = c.dataset.devId;
      if (!state.cardPos[id]) {
        state.cardPos[id] = { x: c.offsetLeft, y: c.offsetTop };
      }
    });

    // Применяем сохранённые позиции
    cards.forEach(c => {
      const p = state.cardPos[c.dataset.devId];
      c.style.position = 'absolute';
      c.style.left = p.x + 'px';
      c.style.top = p.y + 'px';
    });

    // Высота канваса, чтобы страница корректно прокручивалась
    let maxBottom = 0;
    cards.forEach(c => {
      maxBottom = Math.max(maxBottom, c.offsetTop + c.offsetHeight);
    });
    UI.canvas.style.height = (maxBottom + 24) + 'px';
  }

  function initDrag(card) {
    const head = card.querySelector('.device-card__head');
    if (!head) return;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.device-card__edit') ||
          e.target.closest('.device-card__name-input')) return;
      if (e.button !== 0) return;
      startDrag(e, card);
    });
  }

  function startDrag(e, card) {
    e.preventDefault();
    state.dragging = true;
    const canvasRect = UI.canvas.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    const id = card.dataset.devId;

    card.classList.add('device-card--dragging');
    card.style.zIndex = '50';
    document.body.style.userSelect = 'none';

    function move(ev) {
      const x = snap(Math.max(0, ev.clientX - canvasRect.left - offsetX));
      const y = snap(Math.max(0, ev.clientY - canvasRect.top - offsetY));
      card.style.left = x + 'px';
      card.style.top = y + 'px';
    }

    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.style.userSelect = '';
      card.classList.remove('device-card--dragging');
      card.style.zIndex = '';
      state.cardPos[id] = {
        x: snap(parseInt(card.style.left) || 0),
        y: snap(parseInt(card.style.top) || 0)
      };
      savePositions();
      state.dragging = false;
      layoutCards();
      if (state.pendingStatus) {
        const s = state.pendingStatus;
        state.pendingStatus = null;
        renderStatus(s);
      }
    }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /* ---------- Опрос статуса ---------- */
  let refreshTimer = null;
  async function refreshStatus() {
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const status = await r.json();
      renderStatus(status);
      setConn(true, 'онлайн');
    } catch (e) {
      setConn(false, 'нет связи с сервером');
    }
    scheduleNext();
  }

  function scheduleNext() {
    clearTimeout(refreshTimer);
    if (!statusAuto.enabled) return;
    refreshTimer = setTimeout(refreshStatus, statusAuto.intervalMs);
  }

  function applyStatusPrefsToUI() {
    UI.statusAuto.checked = statusAuto.enabled;
    UI.statusInterval.value = String(Math.round(statusAuto.intervalMs / 1000));
  }

  $('#btnRefresh').addEventListener('click', () => { refreshStatus(); });

  UI.statusAuto.addEventListener('change', () => {
    statusAuto.enabled = UI.statusAuto.checked;
    saveStatusPrefs();
    if (statusAuto.enabled) refreshStatus();
    else { clearTimeout(refreshTimer); refreshTimer = null; }
  });

  UI.statusInterval.addEventListener('change', () => {
    let s = Number(UI.statusInterval.value);
    if (!(s >= 1 && s <= 3600)) s = 3;
    UI.statusInterval.value = String(s);
    statusAuto.intervalMs = s * 1000;
    saveStatusPrefs();
    if (statusAuto.enabled) { scheduleNext(); refreshStatus(); }
  });

  /* ---------- Редактор конфигурации ---------- */
  const REG_TYPES = ['holding', 'input', 'coil', 'discrete'];
  const DATA_TYPES = ['uint16', 'int16', 'uint32', 'int32', 'float', 'bool'];

  function deviceRow(dev, idx) {
    const wrap = el('div', 'device-edit');
    wrap.dataset.devId = dev.id || '';

    const head = el('div', 'device-edit__head');
    const title = el('div', 'device-edit__title');
    const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chev.setAttribute('viewBox', '0 0 24 24');
    chev.classList.add('device-edit__chev');
    chev.innerHTML = '<path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
    title.appendChild(chev);
    title.appendChild(document.createTextNode(dev.name || ('Устройство ' + (idx + 1))));
    const hostSpan = el('span', 'device-edit__host', `${dev.host}:${dev.port} · unit ${dev.unitId}`);
    head.appendChild(title);
    head.appendChild(hostSpan);
    head.addEventListener('click', () => head.classList.toggle('open'));
    wrap.appendChild(head);

    const body = el('div', 'device-edit__body');

    // Параметры устройства
    const devForm = el('form', 'form');
    devForm.innerHTML = `
      <div class="form__row" style="grid-template-columns:1fr 1fr 1fr 1fr;">
        <label class="field"><span>Имя</span><input class="f-name" type="text"></label>
        <label class="field"><span>Host</span><input class="f-host" type="text" placeholder="192.168.1.100"></label>
        <label class="field"><span>Порт</span><input class="f-port" type="number" value="502"></label>
        <label class="field"><span>Unit ID</span><input class="f-unit" type="number" value="1"></label>
      </div>
    `;
    body.appendChild(devForm);
    devForm.querySelector('.f-name').value = dev.name || '';
    devForm.querySelector('.f-host').value = dev.host || '';
    devForm.querySelector('.f-port').value = dev.port || 502;
    devForm.querySelector('.f-unit').value = dev.unitId || 1;

    const regsHead = el('div', 'mini-head');
    regsHead.appendChild(el('span', null, 'Регистры'));
    const addReg = el('button', 'btn btn--ghost btn--sm', 'Добавить регистр');
    addReg.addEventListener('click', () => {
      dev.registers.push({ id: 'r' + Date.now().toString(36), name: 'Новый регистр', address: 0, type: 'holding', dataType: 'uint16', scale: 1, unit: '', decimals: 0 });
      renderRegisters(dev);
    });
    regsHead.appendChild(addReg);
    body.appendChild(regsHead);

    const regsWrap = el('div', 'regs');
    body.appendChild(regsWrap);

    function renderRegisters(d) {
      regsWrap.innerHTML = '';
      d.registers.forEach((reg, i) => {
        const wrapL = el('div', 'reg-row');
        wrapL.dataset.regId = reg.id || '';

        const row1 = el('div', 'form__row');
        row1.style.gridTemplateColumns = '1.5fr 0.7fr 0.9fr 1fr';

        const row2 = el('div', 'form__row');
        row2.style.gridTemplateColumns = '0.8fr 0.8fr 0.7fr auto auto';

        const mk = (field, opts, target) => {
          const f = el('label', 'field');
          f.appendChild(el('span', null, field));
          if (opts) {
            const sel = document.createElement('select');
            for (const o of opts) {
              const opt = document.createElement('option');
              opt.value = o; opt.textContent = o;
              sel.appendChild(opt);
            }
            sel.value = reg[field] !== undefined ? reg[field] : opts[0];
            sel.addEventListener('change', () => { reg[field] = sel.value; });
            f.appendChild(sel);
          } else {
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.value = reg[field] !== undefined ? reg[field] : '';
            inp.addEventListener('change', (e) => {
              const v = e.target.value;
              reg[field] = (field === 'name' || field === 'unit') ? v : Number(v);
            });
            f.appendChild(inp);
          }
          target.appendChild(f);
        };

        mk('name', null, row1);
        mk('address', null, row1);
        mk('type', REG_TYPES, row1);
        mk('dataType', DATA_TYPES, row1);
        mk('scale', null, row2);
        mk('unit', null, row2);
        mk('decimals', null, row2);

        const wcb = el('label', 'field field--check');
        const wInp = document.createElement('input');
        wInp.type = 'checkbox';
        wInp.className = 'reg-writable';
        wInp.checked = !!reg.writable;
        wInp.title = 'Разрешить запись значения с панели';
        wInp.addEventListener('change', () => { reg.writable = wInp.checked; });
        wcb.appendChild(wInp);
        wcb.appendChild(el('span', null, 'Запись'));
        row2.appendChild(wcb);

        const btns = el('div', 'reg-btns');
        const up = el('button', 'btn btn--ghost btn--sm', '↑');
        const down = el('button', 'btn btn--ghost btn--sm', '↓');
        const del = el('button', 'btn btn--danger btn--sm', '✕');
        up.addEventListener('click', () => swap(i, i - 1));
        down.addEventListener('click', () => swap(i, i + 1));
        del.addEventListener('click', () => {
          d.registers.splice(i, 1);
          renderRegisters(d);
        });
        btns.appendChild(up); btns.appendChild(down); btns.appendChild(del);
        row2.appendChild(btns);

        wrapL.appendChild(row1);
        wrapL.appendChild(row2);
        regsWrap.appendChild(wrapL);
      });
    }

    function swap(a, b) {
      if (b < 0 || b >= dev.registers.length) return;
      const t = dev.registers[a];
      dev.registers[a] = dev.registers[b];
      dev.registers[b] = t;
      renderRegisters(dev);
    }

    renderRegisters(dev);

    // Кнопки устройства
    const actions = el('div', 'panel__actions');
    const delBtn = el('button', 'btn btn--danger', 'Удалить устройство');
    delBtn.addEventListener('click', () => {
      wrap.remove();
    });
    actions.appendChild(delBtn);
    body.appendChild(actions);

    wrap.appendChild(body);
    return wrap;
  }

  function renderConfigEditor() {
    UI.deviceList.innerHTML = '';
    if (!state.config) return;
    state.config.devices.forEach((dev, i) => UI.deviceList.appendChild(deviceRow(dev, i)));
    const lg = state.config.logging || {};
    UI.logEnabled.checked = lg.enabled !== false;
    UI.logInterval.value = lg.minIntervalMs != null ? (lg.minIntervalMs / 1000) : 5;
    UI.logMax.value = lg.maxEntries != null ? lg.maxEntries : 1000;
  }

  function readEditor() {
    return [...UI.deviceList.querySelectorAll('.device-edit')].map(wrap => {
      const f = wrap.querySelector('.form');
      const dev = {
        id: wrap.dataset.devId || 'd' + Math.random().toString(36).slice(2, 8),
        name: f.querySelector('.f-name').value,
        host: f.querySelector('.f-host').value.trim(),
        port: Number(f.querySelector('.f-port').value) || 502,
        unitId: Number(f.querySelector('.f-unit').value) || 1,
        registers: []
      };
      wrap.querySelectorAll('.reg-row').forEach(row => {
        const c = (n) => row.querySelectorAll('input, select')[n];
        dev.registers.push({
          id: row.dataset.regId || 'r' + Math.random().toString(36).slice(2, 8),
          name: c(0).value,
          address: Number(c(1).value) || 0,
          type: c(2).value,
          dataType: c(3).value,
          scale: Number(c(4).value) || 1,
          unit: c(5).value,
          decimals: Number(c(6).value) || 0,
          writable: !!row.querySelector('.reg-writable').checked
        });
      });
      return dev;
    });
  }

  $('#btnConfig').addEventListener('click', () => {
    const open = UI.configPanel.hidden;
    UI.configPanel.hidden = !open;
    if (open) renderConfigEditor();
  });

  $('#btnJournal').addEventListener('click', () => {
    const open = UI.journalPanel.hidden;
    UI.journalPanel.hidden = !open;
    if (open) {
      fillJournalDeviceFilter();
      loadJournal();
    }
  });

  UI.journalMode.querySelectorAll('.segmented__btn').forEach(b => {
    b.addEventListener('click', () => {
      journal.mode = b.dataset.mode;
      saveJournalPrefs();
      renderJournalModeUI();
    });
  });

  UI.journalDevice.addEventListener('change', () => {
    journal.device = UI.journalDevice.value;
    fillJournalRegFilter();
    saveJournalPrefs();
    loadJournal();
  });

  UI.journalReg.addEventListener('change', () => {
    journal.reg = UI.journalReg.value;
    saveJournalPrefs();
    loadJournal();
  });

  UI.journalLimit.addEventListener('change', () => {
    journal.limit = Number(UI.journalLimit.value) || 200;
    saveJournalPrefs();
    loadJournal();
  });

  UI.journalAuto.addEventListener('change', () => {
    journal.auto = UI.journalAuto.checked;
    saveJournalPrefs();
  });

  $('#btnJournalRefresh').addEventListener('click', () => loadJournal());

  $('#btnJournalCsv').addEventListener('click', async () => {
    const q = new URLSearchParams({ format: 'csv' });
    if (journal.device) q.set('device', journal.device);
    if (journal.reg) q.set('reg', journal.reg);
    try {
      const res = await fetch('/api/log?' + q, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const a = document.createElement('a');
      const url = URL.createObjectURL(blob);
      a.href = url;
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.download = 'modbus-log-' + ts + '.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch { /* нет доступа */ }
  });

  $('#btnJournalClear').addEventListener('click', async () => {
    if (!confirm('Очистить журнал событий?')) return;
    try {
      await fetch('/api/log', { method: 'DELETE' });
      journal.prevKeys = new Set();
      loadJournal();
    } catch { /* нет доступа */ }
  });

  setInterval(() => {
    if (!UI.journalPanel.hidden && journal.auto) loadJournal();
  }, 3000);

  let journalResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(journalResizeTimer);
    journalResizeTimer = setTimeout(() => {
      if (!UI.journalPanel.hidden && journal.mode === 'graph') renderJournalGraph();
    }, 150);
  });

  $('#btnAddDevice').addEventListener('click', () => {
    state.config.devices.push({
      id: 'd' + Date.now().toString(36),
      name: 'Новое устройство',
      host: '192.168.1.100',
      port: 502,
      unitId: 1,
      registers: [{ id: 'r' + Date.now().toString(36), name: 'Регистр 0', address: 0, type: 'holding', dataType: 'uint16', scale: 1, unit: '', decimals: 0 }]
    });
    renderConfigEditor();
  });

  $('#btnSave').addEventListener('click', async () => {
    const devices = readEditor();
    const payload = Object.assign({}, state.config, { devices });
    payload.logging = {
      enabled: UI.logEnabled.checked,
      minIntervalMs: (Number(UI.logInterval.value) || 0) * 1000,
      maxEntries: Number(UI.logMax.value) || 1000
    };
    UI.saveNote.hidden = true;
    UI.saveNote.className = 'note';
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      state.config = data.config;
      UI.saveNote.textContent = 'Сохранено. Устройства будут опрошены заново.';
      UI.saveNote.className = 'note note--ok';
      UI.saveNote.hidden = false;
      scheduleNext();
    } catch (e) {
      UI.saveNote.textContent = 'Ошибка сохранения: ' + e.message;
      UI.saveNote.className = 'note note--err';
      UI.saveNote.hidden = false;
    }
  });

  /* ---------- Тест соединения ---------- */
  UI.testForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(UI.testForm);
    const body = {
      host: data.get('host'),
      port: Number(data.get('port')),
      unitId: Number(data.get('unitId')),
      type: data.get('type'),
      address: Number(data.get('address')),
      count: Number(data.get('count'))
    };
    UI.testResult.hidden = true;
    UI.testResult.innerHTML = '';
    try {
      const r = await fetch('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const res = await r.json();
      if (!r.ok) throw new Error(res.error || 'Ошибка');
      const isBool = body.type === 'coil' || body.type === 'discrete';
      res.values.forEach((v, i) => {
        const row = el('div', 'test-result__row');
        row.appendChild(el('span', 'test-result__addr', `0x${(body.address + i).toString(16).toUpperCase()}`));
        row.appendChild(el('span', 'test-result__val', String(v)));
        UI.testResult.appendChild(row);
      });
      UI.testResult.hidden = false;
    } catch (err) {
      UI.testResult.appendChild(el('div', 'test-result__err', 'Не удалось прочитать: ' + err.message));
      UI.testResult.hidden = false;
    }
  });

  /* ---------- Тревоги ---------- */
  function openAlarmsPanel() {
    const open = UI.alarmsPanel.hidden;
    UI.alarmsPanel.hidden = !open;
    if (open) loadAlarms();
  }

  $('#btnAlarms').addEventListener('click', openAlarmsPanel);
  UI.btnAlarmBannerGo.addEventListener('click', openAlarmsPanel);

  async function loadAlarms() {
    try {
      const r = await fetch('/api/alarms', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      state.alarms = { config: data.config, active: data.active || [] };
      renderAlarmsUI();
    } catch { /* сервер недоступен */ }
  }

  function renderAlarmsUI() {
    const A = state.alarms.config || {};
    UI.alarmsEnabled.checked = A.enabled !== false;
    UI.alarmsResend.value = A.resendIntervalSec != null ? A.resendIntervalSec : 3600;

    const tg = A.notify && A.notify.telegram ? A.notify.telegram : {};
    document.querySelector('.tg-enabled').checked = !!tg.enabled;
    document.querySelector('.tg-token').value = tg.botToken || '';
    document.querySelector('.tg-chat').value = tg.chatId || '';

    const http = A.notify && A.notify.http ? A.notify.http : {};
    document.querySelector('.http-enabled').checked = !!http.enabled;
    document.querySelector('.http-url').value = http.url || '';
    document.querySelector('.http-headers').value = http.headers ? JSON.stringify(http.headers) : '';

    const em = A.notify && A.notify.email ? A.notify.email : {};
    document.querySelector('.em-enabled').checked = !!em.enabled;
    document.querySelector('.em-host').value = em.host || '';
    document.querySelector('.em-port').value = em.port || (em.secure ? 465 : 587);
    document.querySelector('.em-secure').checked = !!em.secure;
    document.querySelector('.em-starttls').checked = em.starttls !== false;
    document.querySelector('.em-user').value = em.user || '';
    document.querySelector('.em-pass').value = em.password || '';
    document.querySelector('.em-from').value = em.from || '';
    document.querySelector('.em-to').value = em.to || '';

    renderActiveAlarms();
    renderAlarmRules();
  }

  function renderActiveAlarms() {
    const list = state.alarms.active || [];
    UI.alarmsActiveEmpty.hidden = list.length > 0;
    UI.alarmsActiveList.innerHTML = '';
    for (const al of list) {
      const row = el('div', 'alarm-row alarm-row--' + (al.severity || 'warning'));
      row.appendChild(el('span', 'alarm-row__tag', (al.severity || 'warning').toUpperCase()));
      const body = el('span', 'alarm-row__body');
      body.appendChild(el('span', 'alarm-row__msg', al.message || al.ruleId));
      body.appendChild(el('span', 'alarm-row__meta',
        'с ' + new Date(al.since).toLocaleString('ru-RU') + ' · значение ' + al.value));
      row.appendChild(body);
      UI.alarmsActiveList.appendChild(row);
    }
  }

  function alarmRuleRow(rule) {
    const wrap = el('div', 'alarm-rule');
    const devices = state.config ? state.config.devices : [];
    const currentDev = devices.find(d => d.id === rule.deviceId);

    const mkSel = (opts) => {
      const s = document.createElement('select');
      for (const o of opts) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        s.appendChild(opt);
      }
      return s;
    };

    const selDev = mkSel(devices.map(d => ({ value: d.id, label: d.name || d.id })));
    if (currentDev) selDev.value = rule.deviceId;

    const selReg = document.createElement('select');
    const fillRegs = () => {
      selReg.innerHTML = '';
      const dev = devices.find(d => d.id === selDev.value);
      (dev ? dev.registers || [] : []).forEach(r => {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = (r.name || r.id) + ' (' + (r.type || 'holding') + ' ' + r.address + ')';
        selReg.appendChild(opt);
      });
      if (rule.registerId && [...selReg.options].some(o => o.value === rule.registerId)) {
        selReg.value = rule.registerId;
      }
    };
    fillRegs();

    const selKind = mkSel([
      { value: 'value', label: 'По значению' },
      { value: 'coil', label: 'По coil (вкл/выкл)' }
    ]);
    selKind.value = rule.kind === 'coil' ? 'coil' : 'value';

    const selCond = mkSel(['>', '>=', '<', '<=', '==', '!='].map(c => ({ value: c, label: c })));
    if (rule.condition) selCond.value = rule.condition;

    const inpThr = document.createElement('input');
    inpThr.type = 'number';
    inpThr.step = 'any';
    inpThr.value = rule.threshold != null ? rule.threshold : 0;

    const inpHys = document.createElement('input');
    inpHys.type = 'number';
    inpHys.step = 'any';
    inpHys.min = '0';
    inpHys.value = rule.hysteresis != null ? rule.hysteresis : 0;

    const selCoil = mkSel([{ value: 'true', label: 'ВКЛ (true)' }, { value: 'false', label: 'ВЫКЛ (false)' }]);
    selCoil.value = String(rule.coilValue !== false);

    const selSev = mkSel(['info', 'warning', 'critical'].map(s => ({ value: s, label: s })));
    selSev.className = 'alarm-rule__sev';
    if (rule.severity) selSev.value = rule.severity;

    const inpMsg = document.createElement('input');
    inpMsg.type = 'text';
    inpMsg.className = 'alarm-rule__msg';
    inpMsg.value = rule.message || '';

    const syncKind = () => {
      const dev = devices.find(d => d.id === selDev.value);
      const reg = dev ? (dev.registers || []).find(r => r.id === selReg.value) : null;
      if (reg && (reg.type === 'coil' || reg.type === 'discrete' || reg.dataType === 'bool')) {
        selKind.value = 'coil';
      } else if (selKind.value === 'coil') {
        selKind.value = 'value';
      }
    };

    selDev.addEventListener('change', () => { fillRegs(); syncKind(); });
    selReg.addEventListener('change', syncKind);

    const delBtn = el('button', 'btn btn--danger btn--sm', '✕');
    delBtn.type = 'button';
    delBtn.addEventListener('click', () => wrap.remove());

    const f = (label, ctrl) => {
      const l = el('label', 'field');
      l.appendChild(el('span', null, label));
      l.appendChild(ctrl);
      return l;
    };

    const row1 = el('div', 'form__row');
    row1.style.gridTemplateColumns = '1fr 1fr 1.1fr auto';
    row1.appendChild(f('Устройство', selDev));
    row1.appendChild(f('Регистр', selReg));
    row1.appendChild(f('Тип', selKind));
    const btnCell = el('div', 'field field--action');
    btnCell.appendChild(delBtn);
    row1.appendChild(btnCell);

    const row2 = el('div', 'form__row alarm-rule__value-fields');
    row2.style.gridTemplateColumns = '0.8fr 0.8fr 0.8fr 1.2fr';
    const valFields = el('div', 'alarm-rule__valfields');
    valFields.appendChild(f('Условие', selCond));
    valFields.appendChild(f('Порог', inpThr));
    valFields.appendChild(f('Гистерезис', inpHys));
    valFields.appendChild(f('Сообщение', inpMsg));
    const coilFields = el('div', 'alarm-rule__coilfields');
    coilFields.appendChild(f('Состояние', selCoil));
    coilFields.appendChild(f('Сообщение', inpMsg));
    row2.appendChild(valFields);
    row2.appendChild(coilFields);

    const sevRow = el('div', 'form__row');
    sevRow.style.gridTemplateColumns = '0.6fr';
    sevRow.appendChild(f('Важность', selSev));

    const toggleKindFields = () => {
      const coil = selKind.value === 'coil';
      valFields.hidden = coil;
      coilFields.hidden = !coil;
    };
    selKind.addEventListener('change', toggleKindFields);
    toggleKindFields();
    syncKind();

    wrap.appendChild(row1);
    wrap.appendChild(row2);
    wrap.appendChild(sevRow);
    return wrap;
  }

  function renderAlarmRules() {
    UI.alarmsRules.innerHTML = '';
    const rules = state.alarms.config && state.alarms.config.rules ? state.alarms.config.rules : [];
    if (!rules.length) {
      UI.alarmsRules.appendChild(el('p', 'empty', 'Правил пока нет. Добавьте правило — например, выход температуры за порог или открытие клапана.'));
      return;
    }
    for (const rule of rules) UI.alarmsRules.appendChild(alarmRuleRow(Object.assign({}, rule)));
  }

  $('#btnAlarmAddRule').addEventListener('click', () => {
    const dev = state.config && state.config.devices[0];
    const reg = dev && dev.registers[0];
    const rule = {
      id: 'a' + Date.now().toString(36),
      deviceId: dev ? dev.id : '',
      registerId: reg ? reg.id : '',
      condition: '>',
      threshold: 0,
      hysteresis: 0,
      severity: 'warning',
      message: ''
    };
    UI.alarmsRules.appendChild(alarmRuleRow(rule));
  });

  function readAlarmsUI() {
    const headersRaw = document.querySelector('.http-headers').value.trim();
    let headers = {};
    if (headersRaw) {
      try { headers = JSON.parse(headersRaw); } catch { headers = {}; }
    }
    return {
      enabled: UI.alarmsEnabled.checked,
      resendIntervalSec: Math.max(0, Number(UI.alarmsResend.value) || 0),
      notify: {
        telegram: {
          enabled: document.querySelector('.tg-enabled').checked,
          botToken: document.querySelector('.tg-token').value.trim(),
          chatId: document.querySelector('.tg-chat').value.trim()
        },
        http: {
          enabled: document.querySelector('.http-enabled').checked,
          url: document.querySelector('.http-url').value.trim(),
          headers
        },
        email: {
          enabled: document.querySelector('.em-enabled').checked,
          host: document.querySelector('.em-host').value.trim(),
          port: Number(document.querySelector('.em-port').value) || 587,
          secure: document.querySelector('.em-secure').checked,
          starttls: document.querySelector('.em-starttls').checked,
          user: document.querySelector('.em-user').value.trim(),
          password: document.querySelector('.em-pass').value,
          from: document.querySelector('.em-from').value.trim(),
          to: document.querySelector('.em-to').value.trim()
        }
      }
    };
  }

  function readAlarmsRules() {
    const rules = [];
    for (const wrap of UI.alarmsRules.querySelectorAll('.alarm-rule')) {
      const selDev = wrap.querySelector('select');
      const selReg = wrap.querySelectorAll('select')[1];
      const selKind = wrap.querySelectorAll('select')[2];
      const coil = selKind.value === 'coil';
      const valFields = wrap.querySelector('.alarm-rule__valfields');
      const coilFields = wrap.querySelector('.alarm-rule__coilfields');
      const severity = wrap.querySelector('.alarm-rule__sev').value;
      let rule = {
        id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        deviceId: selDev.value,
        registerId: selReg.value,
        kind: coil ? 'coil' : 'value',
        severity
      };
      if (coil) {
        rule.coilValue = coilFields.querySelector('select').value === 'true';
        rule.message = coilFields.querySelector('input').value.trim();
      } else {
        rule.condition = valFields.querySelectorAll('select')[0].value;
        rule.threshold = Number(valFields.querySelectorAll('input')[0].value) || 0;
        rule.hysteresis = Number(valFields.querySelectorAll('input')[1].value) || 0;
        rule.message = valFields.querySelectorAll('input')[2].value.trim();
      }
      rules.push(rule);
    }
    return rules;
  }

  async function saveAlarms() {
    UI.alarmsNote.hidden = true;
    UI.alarmsNote.className = 'note';
    try {
      const payload = readAlarmsUI();
      payload.rules = readAlarmsRules();
      const r = await fetch('/api/alarms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
      state.alarms.config = data.config;
      UI.alarmsNote.textContent = 'Тревоги сохранены. Правила пересчитаются при следующем опросе.';
      UI.alarmsNote.className = 'note note--ok';
      UI.alarmsNote.hidden = false;
      refreshStatus();
    } catch (e) {
      UI.alarmsNote.textContent = 'Ошибка сохранения: ' + e.message;
      UI.alarmsNote.className = 'note note--err';
      UI.alarmsNote.hidden = false;
    }
  }

  $('#btnAlarmsSave').addEventListener('click', saveAlarms);

  /* ---------- Инициализация ---------- */
  loadPositions();
  loadBrand();
  loadJournalPrefs();
  UI.journalLimit.value = String(journal.limit);
  UI.journalAuto.checked = journal.auto;
  UI.journalMode.querySelectorAll('.segmented__btn').forEach(b => b.classList.toggle('is-active', b.dataset.mode === journal.mode));
  loadStatusPrefs();
  applyStatusPrefsToUI();
  let savedTheme = null;
  try { savedTheme = localStorage.getItem(STORAGE_THEME); } catch { /* нет доступа */ }
  applyTheme(savedTheme || 'emerald');

  UI.themeSelect.addEventListener('change', () => applyTheme(UI.themeSelect.value));

  UI.brandTitleEdit.addEventListener('click', () => editBrandText(UI.brandTitle, 'brand__title-input', saveBrand));
  UI.brandSubEdit.addEventListener('click', () => editBrandText(UI.brandSub, 'brand__sub-input', saveBrand));

  (async function init() {
    try {
      const r = await fetch('/api/config', { cache: 'no-store' });
      state.config = await r.json();
    } catch { /* без конфига */ }
    loadNet();
    renderConfigEditor();
    refreshStatus();
  })();
})();
