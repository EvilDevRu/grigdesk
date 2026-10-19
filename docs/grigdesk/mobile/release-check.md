# Проверка release-сборки до подписи

Android release-вариант можно собрать и проверить без создания постоянного ключа.
Если `GRIGDESK_ANDROID_STORE_FILE` не задан, Gradle не подключает signingConfig и создаёт
`mobile/android/client/build/outputs/apk/release/client-release-unsigned.apk`.

После подготовки Java/SDK и встроенного полного UI по [инструкции сборки](android-build.md):

```bash
cd mobile/android
./gradlew --no-daemon --max-workers=2 :client:assembleRelease :client:lintRelease
```

Эта проверка компилирует release Java/resources и выполняет lint. В итоговом manifest
нет разрешённой отладки; `allowBackup` и `usesCleartextTraffic` отключены.
`MainActivity` включает WebView debugging только при Android-флаге DEBUGGABLE.

Unsigned APK не является опубликованным выпуском: `apksigner verify` ожидаемо
отклоняет отсутствие подписи. Его не размещают под именем `grigdesk-mobile.apk`
и не предлагают телефону как обновление. Существующий ключ, проверенная подпись и
metadata требуются для `tools/mobile release` после решения владельца.

Release сборка/lint не подтверждают физическую биометрию, Keystore, lifecycle и
установку поверх прежней версии: они проверяются отдельно на устройстве.

`tools/mobile release` требует уже существующий ключ через GRIGDESK_ANDROID_STORE_FILE,
GRIGDESK_ANDROID_STORE_PASSWORD, GRIGDESK_ANDROID_KEY_PASSWORD и GRIGDESK_ANDROID_KEY_ALIAS.
Результаты —grigdesk-mobile-release.apk и grigdesk-mobile-release.json в папке APK.
Версия 0.1.0 и versionCode100 до первого выпуска не повышаются. Эта команда не публикует
обновление через сервер и не создаёт новый ключ. Прежний :app проверяется отдельно в check.
