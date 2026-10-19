# Проверка готового пакета приложения

Packaged smoke запускает готовый ELF обычным spawn без inspector/CDP и без изменения fuses.
Одноразовые GNOME Keyring, D-Bus и Xvfb проверяют показ встроенного UI без сервера и штатный
SIGTERM с кодом 0. AppImage запускается через --appimage-extract-and-run, без требования FUSE.
Снимки сохраняются в GRIGDESK_E2E_ARTIFACTS.

Проверяются release.json, api-version.json, lazy chunks, в том числе SettingsModal,
и исходные ресурсы заставки в app.asar. Fuses: CookieEncryption включён, RunAsNode,
NodeOptions и CLIInspect выключены. Общий модал использует документ и origin главного окна.

DW-P1 исполняет проверку typeof require/process в renderer копии готового пакета.
Main и fuses остаются штатными; заменён только запечатанный тестовый UI, результат идёт
через API трубы. DW-P2 с постоянной серверной cookie снят: серверная сессия хранится только
в памяти трубы, renderer её не получает. Это не отменяет проверки CookieEncryption.

DW-P5 запускает распакованный AppImage через AppRun с runtime.json и --grigdesk-url.
Свой сервер не получает APPDIR/APPIMAGE или пути распаковки в PATH/LD_LIBRARY_PATH и
завершается вместе с приложением. Для него нужен GRIGDESK_PACKAGED_EXTRACTED_EXECUTABLE;
если системная проба supervisor запрещена средой, сценарий отмечается NOT RUN.

Перед запуском задаются абсолютные GRIGDESK_PACKAGED_EXECUTABLE и GRIGDESK_PACKAGED_APPIMAGE
к результатам npm --prefix desktop run dist. Запуск — через isolated-session.sh и сторож
памяти. Установка, фокус оконного менеджера, уведомления и микрофон принимаются человеком.
