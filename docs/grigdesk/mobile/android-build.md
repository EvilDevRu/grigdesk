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

`check` запускает мобильные unit/UI/contract тесты под memory guard, typecheck и app-scoped
Gradle unit/lint. `build` собирает интерфейс для native bridge, делает cap sync из `mobile/`
и создаёт `<папка данных>/state/mobile-apk/grigdesk-mobile-debug.apk`. Android-сборка не входит в общий
`tests/run-all.sh` и не перезапускает рабочий GrigDesk.

## Подписанный выпуск

Первый `tools/mobile release` создаёт ключ только после решения владельца.
По умолчанию каталог — `~/.config/grigdesk/android-signing/` с правами 0700:
`release.jks` и `release.properties` с правами 0600. Перенесённый каталог задаётся
`GRIGDESK_ANDROID_SIGNING_DIR` и также обязан быть вне репозитория. Частично существующее
хранилище закрывает выпуск, а не создаёт новый ключ поверх прежнего.

Ключ RSA 3072/alias grigdesk и случайный пароль нужно сохранить в отдельной защищённой
резервной копии. Потеря подписи исключает обновление установленного приложения поверх
прежнего: потребуется переустановка и новая привязка. Debug и release подписаны разными
ключами и не являются взаимозаменяемыми обновлениями.

Версия берётся из `mobile/package.json`, versionCode — `major*10000+minor*100+patch`;
minor/patch ограничены 99. Новый выпуск должен иметь больший versionCode и прежнюю подпись.
Сборка, apksigner verify, сверка packageId/versionCode/сертификата проходят до публикации.
Ошибка сохраняет предыдущий опубликованный APK.

Готовые файлы — `<папка данных>/state/mobile-apk/grigdesk-mobile.apk` и `grigdesk-mobile.json` с
`version`, `versionCode`, `size`, `sha256`, `builtAt`. APK публикуется атомарно, JSON последним.
`GRIGDESK_MOBILE_APK_DIR` переопределяет каталог. Сборка и выпуск заранее проверяют,
закончен ли перенос данных; ключ подписи и Android SDK остаются снаружи.
Сервер сверяет fixed файл через no-follow FD; конкурентная замена даёт согласованный hash
либо явный `apk_mismatch`. Телефон проверяет размер/hash до FileProvider-установщика;
системное разрешение установки из этого источника выдаёт человек на устройстве.
