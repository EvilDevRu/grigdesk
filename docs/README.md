# Документация Cockpit

Документация хранится отдельно от исполняемого кода и группируется по подсистемам.
Текущую архитектуру описывают `architecture.md` и документы движка; `gotchas.md` сохраняет
историю инцидентов, поэтому версии и даты внутри примеров не являются каталогом актуальных моделей.

## Cockpit

- [architecture.md](cockpit/architecture.md) — сервер, web и границы модулей.
- [factory-graph.md](cockpit/factory-graph.md) — схема фабрики в интерфейсе.
- [chat-agents.md](cockpit/chat-agents.md) — чаты, агенты, провайдеры и разрешения.
- [gotchas.md](cockpit/gotchas.md) — оплаченный инцидентами эксплуатационный контекст.

## Движок фабрики

- [CODEX.md](engine/CODEX.md) — статус и контракт мульти-ИИ, failover и диагностики.
- [ENGINE.md](engine/ENGINE.md) — архитектура движка, инварианты и проверки.
- [PROFILE-CONTRACT.md](engine/PROFILE-CONTRACT.md) — контракт проектного профиля.
- [NEW-PROJECT.md](engine/NEW-PROJECT.md) — подключение нового проекта.

`CLAUDE.md` подключает нужные документы из `docs/cockpit/`, поэтому скрытого второго
каталога документации у проекта больше нет.

Целостность относительных ссылок проверяет:

```bash
node --test tests/docs/*.test.mjs
```

Все безопасные проверки перечислены в [tests/README.md](../tests/README.md).
