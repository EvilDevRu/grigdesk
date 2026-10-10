# Проверка release-сборки до подписи

Android release-вариант можно собрать и проверить без создания постоянного ключа.
Если `COCKPIT_ANDROID_STORE_FILE` не задан, Gradle не подключает signingConfig и создаёт
`mobile/android/app/build/outputs/apk/release/app-release-unsigned.apk`.

После подготовки Java/SDK и native bundle по [инструкции сборки](android-build.md):

```bash
cd mobile/android
./gradlew --no-daemon --max-workers=2 :app:assembleRelease :app:lintRelease
```

Эта проверка компилирует release Java/resources и выполняет lint. В итоговом manifest
нет разрешённой отладки; `allowBackup` и `usesCleartextTraffic` отключены.
`MainActivity` включает WebView debugging только при Android-флаге DEBUGGABLE.

Unsigned APK не является опубликованным выпуском: `apksigner verify` ожидаемо
отклоняет отсутствие подписи. Его не размещают под именем `cockpit-mobile.apk`
и не предлагают телефону как обновление. Постоянный ключ, проверенная подпись и
metadata появляются только через `bin/mobile release` после решения владельца.

Release сборка/lint не подтверждают физическую биометрию, Keystore, lifecycle и
установку поверх прежней версии: они проверяются отдельно на устройстве.
