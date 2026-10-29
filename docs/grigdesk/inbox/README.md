# Входящие

Общий автомат входящих и его источники: Telegram и GitHub Issues.

Читай перед правкой: `server/src/lib/inbox`, `server/src/modules/inbox`, `server/src/lib/github`, `server/src/modules/github`.

## Устройство

- [Общий автомат](state-machine.md)
- [Разбиение карточки на несколько задач](task-splitting.md)
- [Три независимых состояния](independent-states.md)
- [Activation и решения](activation-and-decisions.md)
- [GitHub Issues](github-issues.md)
- [HTTP и real-time](http-and-realtime.md)
- [Identity, leases и stores](identity-leases-and-stores.md)
- [Каркас первого чтения очереди: шапка, вкладки и карточки](loading-layout.md)
- [Telegram](telegram.md)

## Грабли

- [Кнопки «Входящих» мертвы, а автомат работает = роутер режет :param на 100 символов](router-parameter-length.md)
- [Моргнувшая сеть до Telegram выглядит как две РАЗНЫЕ поломки Входящих](telegram-network-failures.md)
- [Пустая карточка Входящих = сообщение приехало в формате rich (Bot API 10.1)](telegram-rich-messages.md)
