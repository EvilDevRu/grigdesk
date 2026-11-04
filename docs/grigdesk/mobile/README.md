# Приложение на телефоне

- [Восстановление интерфейса и чатов: интервалы, плашка и «Подключиться сейчас»](../web/connection-recovery.md)

- [Отказы relay только для своего пути, общий probe и сроки проверки связи](phone-route-recovery.md)

- [Один QR, профиль и автоматический выбор direct/relay](phone-access.md)

Полное Android-приложение содержит общий интерфейс и локальную трубу; привязанные машины
доступны через отдельный клиентский TLS-вход. Прежнее приложение с посредником и контрактом
v1 сохранено отдельно. Основной HTTP и прежний мобильный вход остаются на loopback.

Читай перед правкой: `mobile/`, `relay/`, `server/src/lib/mobile/`,
`server/src/modules/mobile/`, `tools/mobile-phone/`, `tools/mobile`.

## Контракты продукта

- [Актуальный общий интерфейс: Android-пакет, полный охват экранов и пределы сверки](current-ui-parity.md)

- [Машины: текущая карточка, нижнее меню, QR и восстановление связи](machine-connections-design.md)

- [Язык установки :client, общие каталоги и сообщения оболочки](interface-language.md)

- [Полное приложение Android: WebView, локальная труба и нативные действия](client-app.md)
- [Разрешения микрофона WebView и проверка их наличия в готовом APK](microphone-permissions.md)

- [Переход на GrigDesk: пакет 0.1.0, подпись, новая привязка и новые имена протокола v1](app-rename-transition.md)

- [Соответствие дизайну GrigDesk: экраны, состояния, поиск и подтверждения](design-parity.md)
- [Архитектура, два TLS-слоя и QR-привязка](architecture.md)
- [Независимый мобильный контракт v1 и события](contract-v1.md)
- [Доставка операций, повтор и неопределённый результат](operation-delivery.md)
- [Границы возможностей приложения](limitations.md)

## Устройство

- [Полный снимок подключения после разблокировки и совместимость с прежним ответом ok](unlock-shell-snapshot.md)

- [Разблокировка: повтор, поворот системного диалога и карточка входа](unlock-recovery.md)

- [Привязка в настройках: карточки посредников, телефоны и диалог QR](pairing-settings.md)
- [Развёртывание и перенос посредника](relay-deploy.md)
- [Посредник одним файлом: сборка и выпуск](relay-binary.md)
- [Ограниченный журнал контейнера и отключение compression](relay-log.md)
- [Сборка Android, версии и ключ подписи](android-build.md)
- [Локальное окружение Android: FEX, Docker, Termux и Linux-VM](android-runtime.md)
- [Упаковка Linux в APK: rootfs, PRoot и target SDK в DroidDeck](android-linux-packaging.md)
- [Gradle Wrapper в git: зачем хранится, сверка jar и `cap migrate`](gradle-wrapper.md)
- [Проверка release-варианта без создания ключа](release-check.md)
- [Нативная сессия, сертификаты и граница WebView](native-security.md)
- [Раскладка телефона и планшета: рейка, колонки, клавиатура](layout.md)
- [Планшетный разговор: кольцо работы, превью, Markdown и действия](tablet-chat.md)
- [Визуальные расхождения чата с вебом: шапки, узкий список и лента](chat-visual-gaps.md)
- [Поиск и архив как в вебе, настройка вида чата и общая линия хода](chat-layout-controls.md)
- [Создание и настройки чата, плотность планшета, контекст и индикаторы](chat-controls.md)
- [Автоматические проверки, размеры окна и отчёты](checks.md)
- [Браузерный телефон DevLink на живом посреднике](devlink.md)
- [Грабли настоящего Android: thenable-прокси, сокеты на main thread, вырезы](device-pitfalls.md)
- [Пустой раздел «Чаты» на телефоне: полная история не укладывается в таймаут GET](../chat/history-initial-load-timeout.md)
- [Чаты во встроенном UI APK: устаревший пакет, лёгкий список и границы проверки](packaged-chat-history.md)
- [Завершение привязки не отменяет выбранный человеком раздел](pairing-navigation.md)
