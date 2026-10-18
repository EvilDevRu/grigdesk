# Сервер и доступ

Запуск и юнит, авторизация, переменные машины, сеть.

Читай перед правкой: `server/src/app.ts`, `server/src/plugins`, `server/src/modules/auth`, `bin`, `deploy`.

## Устройство

- [Переход на GrigDesk: подготовка, brandMove, журнал, откат и второй этап](brand-migration.md)

- [Node SEA: возможности версий, пробная упаковка и привязки сервера к файловой установке](node-sea.md)

- [Единая папка данных: раскладка, перенос, ранний старт и блокировка](data-home.md)

- [Неизменяемые версии интерфейса из AppImage и защищённая раздача `/ui/<id>/`](../web/packaged-ui.md)

- [Дочерний сервер приложения: владение по IPC, код 75, обновление и контроллер запуска](desktop-owned-server.md)

- [Доступ только через приложение: ключ, миграция сессий, восстановление и проверка агентом](desktop-only-access.md)

- [Единая команда: окно, сервер, посредник, статус и защита хода агента](grigdesk-cli.md)

- [Локальный доступ: один HTTP-сокет и вход по ключу](loopback-access.md)
- [Удалённый доступ через приложение и посредника](../mobile/architecture.md) — оба входа GrigDesk остаются на loopback.
- [Отказ отдельного мобильного TLS-входа не мешает запуску основного GrigDesk](mobile-startup-isolation.md)

- [Авторизация и CLI-токен](authentication-and-cli-token.md)
- [Ключ локального окна: атомарная публикация после listen и обмен на сессию](window-key.md)
- [Программная правка .env — только через общий писатель lib/envFile.ts](env-file-writer.md)
- [Встроенный DeepSeek: переход updater, публикация и восстановление](deepseek-release-transition.md)

## Грабли

- [«Встал агент», «упал прогон», «нет лимитов» — один корень: подсеть docker поверх VPN](docker-vpn-subnet-conflict.md)
- [Ворота VPN проверяют маршрут, а не конкретный клиент](vpn-route-check.md)
- [Вход в GrigDesk: один пользователь, сессионная cookie, гард на ВЕСЬ /api](session-authentication.md)
- [Владельцы порта: служба, ручной запуск и дочерний сервер приложения](server-port-ownership.md)
- [Браузерный удалённый доступ снят; приложение использует отдельный туннель](remote-access-options.md)
- [Машинные переменные — .env в папке данных, общий для всех способов запуска](machine-environment.md)
- [Первичная настройка пароля снята](local-password-bootstrap.md)
- [Сервер — host-native, не контейнеризуется](host-native-runtime.md)
- [StartLimitIntervalSec=0 в юните GrigDesk — не украшение](systemd-start-limit.md)
- [Старт модуля не ждёт тяжёлых проб: лимит Fastify на плагин](plugin-start-timeout.md)
- [Повторный deploy/install.sh без флага включает автозапуск обратно](install-resets-autostart.md)
