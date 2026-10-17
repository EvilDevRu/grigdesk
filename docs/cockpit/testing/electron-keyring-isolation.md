# Изоляция Electron и связки ключей

Linux `safeStorage` может записывать `Chromium Safe Storage` в пользовательскую связку
ключей с атрибутом `application`, равным имени приложения. Даже экспериментальный
запуск поэтому должен использовать одноразовую сессию.

Запускай Electron-проверки только через `tests/desktop/e2e/isolated-session.sh`.
Обёртка создаёт отдельные HOME/XDG-каталоги, D-Bus, GNOME Keyring и Xvfb.
Пароль тестовой связки не используется за пределами этой сессии.
Готовность собственного Secret Service проверяется до запуска команды.
Ошибка подготовки не включает fallback на пользовательскую связку.

Unix-сокет keyring ограничен 108 байтами, поэтому runtime-каталог короткий и лежит в `/tmp`.
`GSETTINGS_BACKEND=memory` и `NO_AT_BRIDGE=1` отключают фоновые службы, которые могли бы
писать в каталог после уборки. Окружение меняется только у дочерней команды.

Общий кэш браузеров Playwright обёртка передаёт явно: если `PLAYWRIGHT_BROWSERS_PATH` не задан,
он вычисляется из настоящего HOME до подмены. Иначе сценарии с чистым Chromium падают на
«Executable doesn't exist» — [перенаправленный кэш](playwright-xdg-cache.md).

Обёртка сохраняет аргументы и код выхода команды. INT/TERM возвращают 130/143.
Cleanup сначала завершает и дожидается своих процессов, затем удаляет свои каталоги.
D-Bus сессии запускает службы по запросу окна: portal монтирует FUSE в runtime-каталоге.
Они не дети обёртки, поэтому cleanup ждёт опустения собственной группы процессов.
Процессы завершаются только по сохранённым PID или собственной группе, никогда по имени.
Журнал сообщает пути и PID данного запуска, без содержимого связки.
Проверять утечки нужно по этим значениям, без удаления чужих каталогов того же префикса.

Проверка обёртки выполняется до Electron через memory guard:

```bash
bash tests/run-node-tests-safe.sh --test tests/desktop/e2e/isolation.test.mjs
```

Она проверяет аргумент с пробелами, коды 0/7/2, отказ подготовки keyring и TERM,
медленный выход службы сессии, а затем отсутствие именно своих каталогов и процессов.

Dev-окно и готовый пакет проверяются отдельными командами:

```bash
NODE_TEST_MAX_RSS_MB=4096 bash tests/desktop/e2e/isolated-session.sh \
  bash tests/run-node-tests-safe.sh --test-concurrency=1 --test tests/desktop/e2e/window.e2e.mjs
NODE_TEST_MAX_RSS_MB=4096 bash tests/desktop/e2e/isolated-session.sh \
  bash tests/run-node-tests-safe.sh --test-concurrency=1 --test tests/desktop/e2e/packaged-smoke.mjs
```

Dev требует свежего desktop build; реальные сценарии — свежего web-dist через COCKPIT_E2E_WEB_DIST.
Перед пакетным запуском задаются абсолютные COCKPIT_PACKAGED_EXECUTABLE,
COCKPIT_PACKAGED_APPIMAGE и COCKPIT_PACKAGED_EXTRACTED_EXECUTABLE:
[подготовка и контракт пакета](desktop-window-package.md). Dev использует Playwright
с Chromium sandbox, готовый пакет — обычный spawn без inspector/CDP.

Отсутствие FUSE даёт NOT RUN только прямого AppImage; распакованное окно и чтение
fuses обоих ELF остаются независимыми. Нет Python/sqlite3 — NOT RUN подслучая базы,
нет WM в Xvfb — NOT RUN maximized. Уведомление Linux, микрофон и видимость настоящего
окна/значка требуют ручной проверки. Ошибка приложения в готовой среде — FAIL.
