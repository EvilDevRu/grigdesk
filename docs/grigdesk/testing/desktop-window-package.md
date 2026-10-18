# Проверка готового пакета и шифрования cookie

`tests/desktop/e2e/packaged-smoke.mjs` запускается через `isolated-session.sh`, как
[dev-проверки окна](desktop-window-e2e.md). Готовый пакет стартует обычным spawn без
inspector/CDP. Playwright `_electron.launch` здесь не применяется: пакет отключает
Node CLI inspector. Подготовка отдельной тестовой сборки с ослабленными fuses не нужна.

Пути задаются абсолютными `GRIGDESK_PACKAGED_EXECUTABLE`, `GRIGDESK_PACKAGED_APPIMAGE`
и `GRIGDESK_PACKAGED_EXTRACTED_EXECUTABLE`. Последний указывает на ELF, извлечённый
собственным `AppImage --appimage-extract` в отдельную папку артефактов. Извлечение
не запускает Electron и не требует FUSE. Тест DW-P3 читает оба ELF через
`@electron/fuses`, не изменяя wire: RunAsNode, NodeOptions и CLIInspect должны быть
DISABLE=48, EnableCookieEncryption — ENABLE=49.

В текущем Linux manifest имя executable — `grigdesk`. Builder выбирает
`build.linux.executableName`, затем `build.executableName`, иначе очищенное имя пакета
в нижнем регистре. Русское productName не является именем ELF.

Пакет публикует собственный resources/ui в отдельный каталог релизов фикстуры.
HTTP-фикстура проверяет manifest по `/ui/<id>/release.json` и выдаёт маленькую страницу
по закреплённому `/ui/<id>/`. Та сообщает `/probe/loaded` свой origin и
отсутствие require/process, затем вызывает `window.close()`. Тест требует штатный
exit=0 без сигнала до удаления профиля или проверки SQLite. Deadline считается FAIL;
принудительное завершение своего child в cleanup успехом не является.

Пакет сначала входит через собственный файл ключа и window-session.
Сервер задаёт дополнительную случайную постоянную HttpOnly cookie только на первый GET. Cookie
проверяется в первом POST до закрытия; после повторного запуска первый GET должен
принести тот же маркер. Повторного Set-Cookie перед этим GET нет. Значения cookie и
зашифрованного BLOB не выводятся.

В проверенном Linux-пакете база находится в `Partitions/grigdesk-local/Cookies`
относительно собственного userData. Тест допускает также `Network/Cookies` внутри
той же partition; глобального поиска нет. Python `-I` открывает SQLite с `mode=ro`:
ровно одна строка `name=stub`, `host_key=127.0.0.1`, пустой value, непустой
encrypted_value и положительный expires_utc. Защищённый backend также подтверждается
проверкой main до session, собственным GNOME Keyring и fuse wire готового пакета.

```bash
export GRIGDESK_PACKAGED_EXECUTABLE="$PWD/desktop/release/linux-unpacked/grigdesk"
export GRIGDESK_PACKAGED_APPIMAGE="$PWD/desktop/release/grigdesk-desktop-0.1.0-x86_64.AppImage"
desktop_package_extract="$HOME/.grigdesk/artifacts/desktop-window/package-extract"
mkdir -p "$desktop_package_extract"
(cd "$desktop_package_extract" && "$GRIGDESK_PACKAGED_APPIMAGE" --appimage-extract)
export GRIGDESK_PACKAGED_EXTRACTED_EXECUTABLE="$desktop_package_extract/squashfs-root/grigdesk"
NODE_TEST_MAX_RSS_MB=4096 bash tests/desktop/e2e/isolated-session.sh \
  bash tests/run-node-tests-safe.sh --test-concurrency=1 --test tests/desktop/e2e/packaged-smoke.mjs
```

DW-P4 читает `resources/app.asar` пакета через `@electron/asar`, Electron не запускает:
`dist/splash/{index.html,style.css,background.png,wordmark.svg}` на месте, SHA-256 картинки совпадает с
утверждённым. DW-P5 запускает `squashfs-root/AppRun` распакованного AppImage (FUSE не нужен)
с [корнем-фикстурой](desktop-startup-e2e.md) и `runtime.json` в XDG_DATA_HOME сессии: пакет
сам поднимает свой сервер, страница фикстуры закрывает окно, выход 0 за 60 с, сервер
завершён. В журнале фикстуры нет `APPDIR`, `APPIMAGE` и путей распаковки в `PATH` и
`LD_LIBRARY_PATH`. Распакованный `AppRun` вычисляет `APPDIR`, но не экспортирует его,
а пути пакета в PATH дописывает. Поэтому окно чистит и каталог своего исполняемого
файла: проверка ловила их в PATH сервера, пока окно знало только `APPDIR` окружения.

При отсутствии `/dev/fuse` только прямой запуск AppImage P1/P2 получает NOT RUN.
Linux-unpacked и оба fuse wire проверяются независимо. Отсутствие Python/sqlite3
пропускает лишь подслучай чтения базы, проверка восстановления cookie остаётся.
При готовой среде отсутствие базы, открытый value или потеря cookie — FAIL.
Видимость окна и значка на настоящем рабочем столе проверяет человек.
