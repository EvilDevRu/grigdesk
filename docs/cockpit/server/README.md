# Сервер и доступ

Запуск и юнит, авторизация, переменные машины, сеть.

Читай перед правкой: `server/src/app.ts`, `server/src/plugins`, `server/src/modules/auth`, `bin`, `deploy`.

## Устройство

- [Локальный доступ: один HTTP-сокет и прежняя авторизация](loopback-access.md)
- [Удалённый доступ через приложение и посредника](../mobile/architecture.md) — оба входа Кокпита остаются на loopback.
- [Отказ отдельного мобильного TLS-входа не мешает запуску основного кокпита](mobile-startup-isolation.md)

- [Авторизация и CLI-токен](authentication-and-cli-token.md)
- [Программная правка .env — только через общий писатель lib/envFile.ts](env-file-writer.md)
- [Встроенный DeepSeek: переход updater, публикация и восстановление](deepseek-release-transition.md)

## Грабли

- [«Встал агент», «упал прогон», «нет лимитов» — один корень: подсеть docker поверх VPN](docker-vpn-subnet-conflict.md)
- [Ворота VPN проверяют маршрут, а не конкретный клиент](vpn-route-check.md)
- [Вход в кокпит: один пользователь, сессионная cookie, гард на ВЕСЬ /api](session-authentication.md)
- [Два владельца порта 8140: systemd-юнит vs bin/restart](server-port-ownership.md)
- [Браузерный удалённый доступ снят; приложение использует отдельный туннель](remote-access-options.md)
- [Машинные переменные — только в корневом .env, у всех трёх способов запуска](machine-environment.md)
- [Первичная настройка пароля — только с самой машины](local-password-bootstrap.md)
- [Сервер — host-native, не контейнеризуется](host-native-runtime.md)
- [StartLimitIntervalSec=0 в юните кокпита — не украшение](systemd-start-limit.md)
