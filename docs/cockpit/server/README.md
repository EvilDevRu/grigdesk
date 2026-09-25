# Сервер и доступ

Запуск и юнит, авторизация, переменные машины, сеть, TLS и шлюз.

Читай перед правкой: `server/src/app.ts`, `server/src/plugins`, `server/src/modules/auth`, `server/src/lib/gateway`, `server/src/lib/tls`, `bin`, `deploy`.

## Устройство

- [Авторизация и CLI-токен](authentication-and-cli-token.md)

## Грабли

- [«Встал агент», «упал прогон», «нет лимитов» — один корень: подсеть docker поверх VPN](docker-vpn-subnet-conflict.md)
- [Адреса стендов снаружи — ПОДДОМЕН, не подпуть](sandbox-subdomain-routing.md)
- [Ворота VPN проверяют маршрут, а не конкретный клиент](vpn-route-check.md)
- [Вход в кокпит: один пользователь, сессионная cookie, гард на ВЕСЬ /api](session-authentication.md)
- [Два владельца порта 8140: systemd-юнит vs bin/restart](server-port-ownership.md)
- [Доступ к кокпиту с других устройств — границы вариантов](remote-access-options.md)
- [Доступ снаружи: шлюз на VPS + два обратных SSH-туннеля](gateway-reverse-tunnels.md)
- [Локальный HTTPS: два сокета в одном процессе, а не «переезд на 8143»](local-https-listeners.md)
- [Машинные переменные — только в корневом .env, у всех трёх способов запуска](machine-environment.md)
- [Первичная настройка пароля — только с самой машины](local-password-bootstrap.md)
- [Работа за шлюзом: COCKPIT_TRUST_PROXY — не true, а адрес соседа](trusted-proxy-address.md)
- [Сервер — host-native, не контейнеризуется](host-native-runtime.md)
- [StartLimitIntervalSec=0 в юните кокпита — не украшение](systemd-start-limit.md)
