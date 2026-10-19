# Сборка Android-приложения

Приложение требует Android 11+ и защищённую блокировку экрана. Strong biometric либо
системный credential разрешают использование Keystore-ключа на 600 секунд.
Совместимость конкретного телефона принимается отдельно на устройстве.

`mobile/toolchain.lock.json` фиксирует Capacitor 8.5.3, Java 21, Gradle 8.14.3, AGP 8.13.0,
compile/target SDK 36, min SDK 30 и версии нативных библиотек. Архивы JDK, CLI tools
и Gradle имеют SHA256. Скрипт не требует sudo и не меняет системную Java.

```bash
npm --prefix mobile ci --include=dev
tools/mobile deps
tools/mobile doctor
tools/mobile check
tools/mobile build
```

`deps` загружает и проверяет закреплённые архивы, принимает SDK-лицензии и устанавливает
пакеты. `doctor` сверяет настоящие исполнимые файлы, версии, установленный SDK и jar
[Gradle Wrapper](gradle-wrapper.md) с суммой из lock.
Пути меняются через `GRIGDESK_ANDROID_JDK`, `GRIGDESK_ANDROID_HOME`,
`GRIGDESK_ANDROID_USER_HOME`, `GRIGDESK_ANDROID_GRADLE_HOME`, `GRIGDESK_MOBILE_DOWNLOADS`.
Конкретные пути машины относятся к локальной документации.

`check` запускает прежние мобильные unit/UI/contract тесты под memory guard, typecheck и
подготовку прежнего :app (mobile build и cap sync), Gradle unit/lint обоих модулей. `build` собирает общий web атомарно через
`tools/client-ui.mts` в client/src/main/assets/ui с api-version.json и release.json, затем
:client:assembleDebug. Результат — grigdesk-mobile-debug.apk в GRIGDESK_MOBILE_APK_DIR.
В build/release Capacitor sync и web/dist не участвуют; старый :app остаётся только в проверках. Android-сборка не входит в общий
`tests/run-all.sh` и не перезапускает рабочий GrigDesk.

## Подписанный выпуск

`tools/mobile release` собирает :client:assembleRelease с уже существующим ключом из
GRIGDESK_ANDROID_STORE_FILE, GRIGDESK_ANDROID_STORE_PASSWORD, GRIGDESK_ANDROID_KEY_PASSWORD,
GRIGDESK_ANDROID_KEY_ALIAS. Новый ключ автоматически не создаётся. Подпись APK сверяется с
этим ключом через apksigner/keytool, пакет и версия — через aapt2 и mobile/package.json.
До первого выпуска версия остаётся 0.1.0, versionCode 100.

Готовые grigdesk-mobile-release.apk и grigdesk-mobile-release.json остаются в каталоге
сборки GRIGDESK_MOBILE_APK_DIR. Публикации, установки на устройство и раздачи обновления
с сервером эта команда не выполняет. APK legacy-приложения и его протокол обновлений
остаются отдельными. Прежний пакет того же applicationId перед установкой удаляет человек.
