# Три независимых состояния

У каждого канала есть три оси, и UI не смешивает их:

| ось | действие | что меняется |
|---|---|---|
| системный плагин | включить/выключить в настройках | доступны ли страница, routes и network loop канала |
| provider connection | `connect`, `recheck`, `disconnect` на странице канала | credentials, ingress и verified provider identity |
| участие в Inbox | `activate`, `deactivate` на `/inbox` | допускаются ли новые сообщения в общую очередь |

Connect не активирует Inbox. Activate не подключает provider. Обычное выключение общего
плагина Inbox не стирает channel stores и не отключает provider ingress.

`deactivate` атомарно закрывает текущую activation epoch. Сообщения до первой activation
и в промежутке между epochs не становятся backlog после следующего включения. Уже
допущенные unresolved items остаются видимыми. `disconnect` сначала отзывает новый ingress
и leases, ждёт начатые account-scoped операции, закрывает открытую epoch и удаляет только
active credentials; сохранённый namespace остаётся доступен read-only.

Reconnect той же immutable provider identity возвращает тот же `accountRef`, archive,
rules, activation history и decisions, но сам Inbox повторно не активирует. Другой bot
или repository получает новый случайный `accountRef`, пустой allowlist и состояние
`never_activated`.

Источник до переноса: docs/cockpit/inbox.md § Три независимых состояния
