# Переход приложения телефона на GrigDesk

Новый Android-пакет — `local.grigdesk.mobile`, имя — GrigDesk, версия — 0.1.0,
versionCode — 100: выпусков GrigDesk ещё не было. Версия берётся из `mobile/package.json`;
Gradle вычисляет код как major × 10000 + minor × 100 + patch.

Номер меньше прежнего приложения 0.1.9, поэтому прежнее приложение не предлагает обновиться
через `/api/mobile/v1/app`: новый пакет ставится вручную. Ранее поставленную сборку GrigDesk
с большим номером (0.2.0) Android поверх не обновит — её удаляют и ставят заново.
Новый applicationId означает отдельную установку: после установки GrigDesk нужно заново
привязать его QR-кодом из настроек. Прежнее приложение и его привязку владелец удаляет
после проверки нового. Установка debug APK не публикует подписанное обновление телефона.
Единое приложение в дальнейшем наследует `local.grigdesk.mobile`, третий пакет не нужен.

## Подпись и метаданные

Полное приложение :client использует существующий ключ владельца через явные
GRIGDESK_ANDROID_STORE_FILE, GRIGDESK_ANDROID_STORE_PASSWORD, GRIGDESK_ANDROID_KEY_PASSWORD
и GRIGDESK_ANDROID_KEY_ALIAS. Отсутствие параметров прекращает выпуск до сборки. Новый ключ
не генерируется; сертификат APK сверяется с указанным хранилищем через keytool/apksigner.

Результат tools/mobile release —grigdesk-mobile-release.apk и grigdesk-mobile-release.json,
debug —grigdesk-mobile-debug.apk. Метаданные содержат размер, SHA-256, сертификат и версию.
Номер 0.1.0/versionCode100 сохраняется до первого выпуска; автоматической проверки роста
по прежнему серверному grigdesk-mobile.json здесь нет. Сервер не раздаёт APK полного клиента.
Прежний release-helper для :app остаётся историческим инструментом протокола v1 и не вызывается
командой tools/mobile release.

## Имена протокола v1

Второй этап переименования сменил имена протокола: `urn:grigdesk:mobile:v1`,
`X-GrigDesk-Operation-Created-At`, `grigdesklink` и значение рабочей папки `grigdesk`. Приложение
0.1.9 с прежними именами с этим сервером не работает; новое приложение собирается заново.
Переименование клиента не требует переиздания сертификатов посредника.

`tools/mobile` берёт JDK/SDK из `.state/android-jdk-21` и `.state/android-sdk`; пути можно
переопределить через GRIGDESK_ANDROID_JDK/GRIGDESK_ANDROID_HOME. DevLink использует юнит
`grigdesk-mobile-devlink` и `~/.config/grigdesk/mobile-devlink`. Release и установка на устройство
остаются действиями владельца; автоматические проверки используют временные каталоги.
