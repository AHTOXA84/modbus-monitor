# Modbus Monitor — установка на Linux

Сервер-дашборд для чтения регистров **Modbus TCP** в локальной сети.
Работает на любом дистрибутиве Linux (systemd), включая Raspberry Pi OS.

## Системные требования

- Linux x64 (amd64) или ARM (arm64, armv7/armhf)
- системный менеджер **systemd** (есть в Debian/Ubuntu, Raspberry Pi OS, Fedora, Arch)
- ~100 МБ свободного места; пакет не требует отдельного веб-сервера

## Быстрая установка

```bash
# 1. Скачать и распаковать
curl -fsSL -o modbus-monitor-linux.tar.gz https://github.com/AHTOXA84/modbus-monitor/releases/download/v1.0-linux/modbus-monitor-1.0-linux.tar.gz
tar xzf modbus-monitor-linux.tar.gz
cd modbus-monitor

# 2. Установить (Node.js установится сам, если его нет)
sudo ./linux/install.sh
```

Что делает установщик:

- устанавливает Node.js 22 LTS, если версия < 18;
- копирует приложение в `/opt/modbus-monitor`;
- ставит зависимости (`npm ci`, только production);
- создаёт системного пользователя `modbusmon`;
- регистрирует сервис `modbus-monitor` и включает автозапуск при загрузке.

После установки панель доступна по адресу **http://IP-устройства:3000**

## Управление сервисом

```bash
sudo systemctl status  modbus-monitor   # статус
sudo systemctl restart modbus-monitor   # перезапуск
sudo systemctl stop    modbus-monitor   # остановка
sudo systemctl disable modbus-monitor   # убрать из автозапуска
```

Логи сервиса: `journalctl -u modbus-monitor -f`

## Порт

По умолчанию сервер слушает порт 3000. Сменить порт до установки:

```bash
sudo PORT=8080 ./linux/install.sh
```

или после установки — правка `/etc/systemd/system/modbus-monitor.service`
(строка `Environment=PORT=...`) и `sudo systemctl daemon-reload && sudo systemctl restart modbus-monitor`.

## Настройка устройств

Конфигурация лежит в `/opt/modbus-monitor/data/config.json` — её можно
править вручную или через веб-интерфейс. По умолчанию включён демо-симулятор
на порту 5020 (внутри панели). Файл журнала событий:
`/opt/modbus-monitor/data/event-log.json`.

## Обновление

```bash
cd modbus-monitor        # распакованный каталог
git pull                 # если клонировали из репозитория — либо перекачайте архив
sudo ./linux/install.sh  # переустановит код и зависимости, конфиг сохранится
```

## Запуск без установки

Если не нужен автозапуск и systemd:

```bash
cd modbus-monitor
npm ci --omit=dev
node server.js           # панель на http://localhost:3000
```

## Брандмауэр (ufw)

```bash
sudo ufw allow 3000/tcp
```

## Дистрибутивы без apt

На Fedora/RHEL/Arch поставьте Node.js 20+ штатным менеджером пакетов,
затем выполните шаги из раздела «Запуск без установки» либо создайте сервис
вручную по образцу `linux/modbus-monitor.service`.