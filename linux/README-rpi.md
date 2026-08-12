# Modbus Monitor — Raspberry Pi

Та же сборка, что и для Linux, проверенная для одноплатников Raspberry Pi.

## Какая модель подходит

| Модель                          | Действие                      |
| ------------------------------- | ----------------------------- |
| Raspberry Pi 5 / 4 / Compute    | ARM64 (aarch64) — полная схема |
| Raspberry Pi 3 (ARMv8 64-bit)   | ставьте 64-bit OS (arm64)     |
| Raspberry Pi 2 / Zero 2         | ARMv7 (armhf) — установщик сам поставит подходящий Node.js |

## Установка на Raspberry Pi OS (Debian)

```bash
# 1. Скачать и распаковать
curl -fsSL -o modbus-monitor-rpi.tar.gz https://github.com/AHTOXA84/modbus-monitor/releases/download/v1.0-rpi/modbus-monitor-1.0-rpi.tar.gz
tar xzf modbus-monitor-rpi.tar.gz
cd modbus-monitor

# 2. Установить
sudo ./linux/install.sh
```

Установщик сам определит архитектуру (`arm64` или `armv7`),
при необходимости поставит Node.js и настроит автозапуск.

## Первый вход

После установки откройте панель с другого устройства в этой сети:
`http://IP-малины:3000` (например `http://192.168.1.50:3000`).

Узнать IP: `hostname -I`

## Что делает Raspberry Pi в мониторинге

- опрашивает контроллеры по `Modbus TCP` (Ethernet) — дополнительных
  модулей и библиотек GPIO не требуется;
- может выступать шлюзом: панель доступна всем устройствам локальной сети.

## Автозапуск при включении питания

Установщик уже включает сервис в автозапуск (`systemctl enable --now`).
Проверить: `systemctl is-enabled modbus-monitor`.

## Полезное для Pi

- Включить SSH и заходить удалённо: `sudo raspi-config` → Interface Options → SSH.
- Обновить ОС перед установкой: `sudo apt update && sudo apt upgrade -y`.
- Для стабильной работы на SD-карте рекомендуется:
  `echo'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf` и перезагрузка.
- ВНИМАНИЕ: демо-симулятор включён по умолчанию. Для работы с реальными
  контроллерами отключите его на главной странице (закладка «Устройства»
  → «Конфигурация») или правкой `data/config.json` (`"simulator": {"enabled": false}`).