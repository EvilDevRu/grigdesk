# Переход приложения телефона на GrigDesk

Новый Android-пакет — `local.grigdesk.mobile`, имя — GrigDesk, версия — 0.1.0,
versionCode — 100: выпусков GrigDesk ещё не было. Версия берётся из `mobile/package.json`;
Gradle вычисляет код как major × 10000 + minor × 100 + patch.

Приложение устанавливается отдельно. Если уже установлен пакет с тем же applicationId
и большим versionCode, Android потребует удалить его перед установкой этой сборки.
После установки привяжите машину по QR из [настроек доступа](phone-access.md).
Сертификаты настроенных посредников сохраняются.

## Подпись и метаданные

Полное приложение :client использует существующий ключ владельца через явные
GRIGDESK_ANDROID_STORE_FILE, GRIGDESK_ANDROID_STORE_PASSWORD, GRIGDESK_ANDROID_KEY_PASSWORD
и GRIGDESK_ANDROID_KEY_ALIAS. Отсутствие параметров прекращает выпуск до сборки. Новый ключ
не генерируется; сертификат APK сверяется с указанным хранилищем через keytool/apksigner.

Результат tools/mobile release — grigdesk-mobile-release.apk и grigdesk-mobile-release.json,
debug — grigdesk-mobile-debug.apk. Метаданные содержат размер, SHA-256, сертификат и версию.
Номер 0.1.0/versionCode100 сохраняется до первого выпуска; автоматической проверки роста
по прежнему серверному grigdesk-mobile.json здесь нет. Сервер не раздаёт APK полного клиента.

`tools/mobile` берёт JDK и SDK из `dev/android/` папки данных. Пути можно переопределить
через `GRIGDESK_ANDROID_JDK` и `GRIGDESK_ANDROID_HOME`. Выпуск и установка на устройство
остаются действиями владельца; автоматические проверки используют временные каталоги.
