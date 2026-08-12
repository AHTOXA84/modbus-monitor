#!/usr/bin/env bash
# =========================================================
#  Modbus Monitor — установка на Linux / Raspberry Pi
#  Запуск:  sudo ./linux/install.sh
#  Требования: bash, curl (или wget), доступ в интернет.
#  Результат: /opt/modbus-monitor + systemd-сервис
#             modbus-monitor  (автозапуск при загрузке)
# =========================================================
set -euo pipefail

APP_NAME="modbus-monitor"
APP_VERSION="${APP_VERSION:-1.0}"
INSTALL_DIR="/opt/modbus-monitor"
SERVICE="modbus-monitor"
SERVICE_USER="modbusmon"
PORT="${PORT:-3000}"

NODE_MAJOR_MIN=18
NODE_VER="${NODE_VER:-22.14.0}"      # резервный tarball nodejs.org

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mОШИБКА:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- права ----------
[ "$(id -u)" -eq 0 ] || die "Запустите от root: sudo ./linux/install.sh"

# ---------- откуда копируем ----------
SRC_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd)"
[ -f "$SRC_DIR/server.js" ] || die "Не найден server.js рядом с install.sh"

log "Источник: $SRC_DIR"

# ---------- определение дистрибутива/архитектуры ----------
. /etc/os-release 2>/dev/null || true
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)   NODE_ARCH="x64";       APT_ARCH="amd64";;
  aarch64|arm64)  NODE_ARCH="arm64";     APT_ARCH="arm64";;
  armv7l|armv6l)  NODE_ARCH="armv7l";    APT_ARCH="armhf";;
  *) die "Архитектура не поддерживается: $ARCH";;
esac
log "Система: ${ID:-linux} ($APT_ARCH)"

# ---------- установка системных пакетов ----------
if command -v apt-get >/dev/null 2>&1; then
  log "Обновление списка пакетов и базовых инструментов сборки..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y -qq
  apt-get install -y -qq curl ca-certificates \
    build-essential python3 >/dev/null
fi

# ---------- Node.js ----------
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v; v="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$v" -ge "$NODE_MAJOR_MIN" ]
}

if node_ok; then
  log "Node.js уже установлен: $(node -v)"
else
  log "Устанавливаю Node.js $NODE_VER ($NODE_ARCH)..."
  if command -v apt-get >/dev/null 2>&1 && [ "$APT_ARCH" != "armhf" ]; then
    # NodeSource для amd64/arm64 (стабильная LTS 22.x)
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 || true
    apt-get install -y -qq nodejs >/dev/null && log "Node.js: $(node -v)"
  fi
  node_ok || {
    # Резерв: официальные tar.xz (включая ARMv7 для старых Raspberry Pi)
    log "Резервный способ: загрузка node-$NODE_VER-linux-$NODE_ARCH..."
    tmp="$(mktemp -d)"
    tar_xz="node-$NODE_VER-linux-$NODE_ARCH.tar.xz"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "https://nodejs.org/dist/v$NODE_VER/$tar_xz" -o "$tmp/$tar_xz"
    else
      wget -q -O "$tmp/$tar_xz" "https://nodejs.org/dist/v$NODE_VER/$tar_xz"
    fi
    tar -xJf "$tmp/$tar_xz" -C "$tmp"
    cp -r "$tmp"/*/bin/* /usr/local/bin/
    cp -r "$tmp"/*/lib/* /usr/local/lib/ 2>/dev/null || true
    mkdir -p /usr/local/include/node
    cp -r "$tmp"/*/include/* /usr/local/include/ 2>/dev/null || true
    rm -rf "$tmp"
  }
  node_ok || die "Не удалось установить Node.js. Проверьте интернет и повторите."
  log "Node.js установлен: $(node -v) | npm: $(npm -v)"
fi

# ---------- копирование приложения ----------
log "Копирование приложения в $INSTALL_DIR ..."
mkdir -p "$INSTALL_DIR"
tar -C "$SRC_DIR" --exclude=node_modules --exclude=.git \
    --exclude=build --exclude=linux -cf - . | tar -C "$INSTALL_DIR" -xf -
mkdir -p "$INSTALL_DIR/data"
cp -a "$SRC_DIR/linux/modbus-monitor.service" "$INSTALL_DIR/modbus-monitor.service" 2>/dev/null || true

# ---------- зависимости ----------
log "Установка зависимостей (npm ci, production)..."
( cd "$INSTALL_DIR" && npm ci --omit=dev --no-audit --no-fund >/dev/null )

# ---------- системный пользователь ----------
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "Создание пользователя $SERVICE_USER ..."
  useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER" || true
fi
chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"

# ---------- systemd ----------
if command -v systemctl >/dev/null 2>&1; then
  log "Регистрация сервиса systemd 'modbus-monitor.service'..."
  sed -e "s|^Environment=PORT=.*|Environment=PORT=$PORT|" \
      -e "s|{{USER}}|$SERVICE_USER|g" \
      "$SRC_DIR/linux/modbus-monitor.service" \
      > /etc/systemd/system/modbus-monitor.service
  systemctl daemon-reload
  systemctl enable --now modbus-monitor >/dev/null
  sleep 2
  systemctl --no-pager --quiet status modbus-monitor || true
  log "Готово! Сервис запущен и включён в автозапуск."
else
  log "systemd не найден — запустите вручную:"
  echo "  PORT=$PORT sudo -u $SERVICE_USER node $INSTALL_DIR/server.js &"
fi

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

  -------------------------------------------------
   Modbus Monitor $APP_VERSION установлен.
   Панель:  http://${HOST_IP:-localhost}:$PORT
   Управление сервисом:
     systemctl status  modbus-monitor
     systemctl restart modbus-monitor
     systemctl stop    modbus-monitor
   Конфигурация: $INSTALL_DIR/data/config.json
  -------------------------------------------------
EOF