# Окружение и IPC дочернего процесса Electron и AppImage

Проверено на Electron 44.7.0, electron-builder 26.15.3 и Node 22.22.1 (14.10.2026).

## Что добавляют Electron и обёртка AppImage

Главный процесс Electron передаёт потомкам своё окружение и дописывает к нему `CHROME_DESKTOP`
и `FC_FONTATIONS=1`. Переменных `ELECTRON_*`, `GTK_*`, `GDK_*` он не добавляет,
`XDG_CURRENT_DESKTOP` не меняет.

Обёртка AppRun, которую генерирует electron-builder для AppImage, перед запуском Electron
экспортирует (`app-builder-lib/out/targets/appimage/appImageUtil.js`):

- `PATH="$APPDIR:$APPDIR/usr/sbin:…"`;
- `LD_LIBRARY_PATH="$APPDIR/usr/lib:…"` — там лежат библиотеки пакета;
- `XDG_DATA_DIRS="$APPDIR/usr/share/:…"` с добавлением системных каталогов;
- `GSETTINGS_SCHEMA_DIR="$APPDIR/usr/share/glib-2.0/schemas:…"`.

Среда AppImage задаёт ещё `APPDIR`, `APPIMAGE`, `ARGV0`, `OWD`. Всё это наследует любой процесс,
запущенный из приложения, вместе со всеми своими потомками. Долгоживущему процессу, который
приложение запускает для себя (например, сервер), нужно убрать эти переменные и элементы путей
внутри `APPDIR`. Распакованный `squashfs-root/AppRun` выставляет `APPDIR` сам и работает без FUSE.

PATH графического сеанса обычно не содержит каталога node из nvm и `~/.local/bin`; юнит systemd
сервера задаёт PATH явно по той же причине.

## IPC с системным node

`child_process.spawn(<системный node>, [скрипт], { stdio: [..., 'ipc'], serialization: 'json' })`
из главного процесса Electron работает: сообщения ходят в обе стороны, у потомка
`process.connected === true`. Node убирает `NODE_CHANNEL_FD` и `NODE_CHANNEL_SERIALIZATION_MODE`
из `process.env` потомка, поэтому его собственные потомки канала не получают.

- Порядок событий у родителя при выходе потомка: `disconnect` → `exit` → `close`; код выхода
  виден в `exit`.
- `kill()` после `exit` возвращает false и сигнал не шлёт.
- После SIGKILL главного процесса Electron потомок получает `'disconnect'` через 16–58 мс и
  может завершиться сам.
- `'close'` ждёт закрытия stdio, которые могут держать уже внуки; конец жизни процесса — `'exit'`.
