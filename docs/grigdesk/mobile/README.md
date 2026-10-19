# Приложение на телефоне

Полное Android-приложение содержит общий интерфейс и локальную трубу; привязанные машины
доступны через отдельный клиентский TLS-вход. Прежнее приложение с посредником и контрактом
v1 сохранено отдельно. Основной HTTP и прежний мобильный вход остаются на loopback.

Читай перед правкой: `mobile/`, `relay/`, `server/src/lib/mobile/`,
`server/src/modules/mobile/`, `tools/mobile-phone/`, `tools/mobile`.

## Контракты продукта

- [Полное приложение Android: WebView, локальная труба и нативные действия](client-app.md)

- [Переход на GrigDesk: пакет 0.1.0, подпись, новая привязка и новые имена протокола v1](app-rename-transition.md)

- [Соответствие дизайну GrigDesk: экраны, состояния, поиск и подтверждения](design-parity.md)
- [Архитектура, два TLS-слоя и QR-привязка](architecture.md)
- [Независимый мобильный контракт v1 и события](contract-v1.md)
- [Доставка операций, повтор и неопределённый результат](operation-delivery.md)
- [Границы возможностей приложения](limitations.md)

## Устройство

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
- [Завершение привязки не отменяет выбранный человеком раздел](pairing-navigation.md)
