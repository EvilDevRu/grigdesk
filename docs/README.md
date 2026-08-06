# Документация Cockpit

Документация хранится отдельно от исполняемого кода и группируется по подсистемам.
Текущую архитектуру описывают `architecture.md` и документы движка; `gotchas.md` сохраняет
историю инцидентов, поэтому версии и даты внутри примеров не являются каталогом актуальных моделей.

Общая документация описывает продукт и контракты, но не перечисляет реальные подключённые
проекты: без их названий, доменов, стеков, task ID и конкретных путей в `profiles/`.
Проектная конкретика хранится только в локальном `profiles/<name>/README.md`; в общих
примерах используются `<PROFILE>`, `<TASK>` и названия режимов `isolated`/`shared`.

## Cockpit

- [architecture.md](cockpit/architecture.md) — сервер, web и границы модулей.
- [b24.md](cockpit/b24.md) — сессионная интеграция Битрикс24, CLI и протокол мутаций.
- [factory-graph.md](cockpit/factory-graph.md) — схема фабрики в интерфейсе.
- [chat-agents.md](cockpit/chat-agents.md) — чаты, агенты, провайдеры и разрешения.
- [documents.md](cockpit/documents.md) — безопасный просмотр Markdown/TXT, ссылки и переходы к строкам.
- [kimi-runtime-security.md](cockpit/kimi-runtime-security.md) — изоляция и security gate чатового Kimi runtime.
- [kimi-workspace-extra-dirs.md](cockpit/kimi-workspace-extra-dirs.md) — доступ Kimi к дополнительным рабочим деревьям.
- [kimi-acp-spike.md](cockpit/kimi-acp-spike.md) — проверенный ACP-контракт Kimi Code.
- [gotchas.md](cockpit/gotchas.md) — оплаченный инцидентами эксплуатационный контекст.

## Движок фабрики

- [MULTI-AI.md](engine/MULTI-AI.md) — статус и контракт мульти-ИИ, failover и диагностики.
- [ENGINE.md](engine/ENGINE.md) — архитектура движка, инварианты и проверки.
- [KIMI.md](engine/KIMI.md) — Kimi runner, классификация отказов и contract-based совместимость CLI.
- [ADDING-RUNNER.md](engine/ADDING-RUNNER.md) — подключение нового provider runner.
- [PROFILE-CONTRACT.md](engine/PROFILE-CONTRACT.md) — контракт проектного профиля.
- [NEW-PROJECT.md](engine/NEW-PROJECT.md) — подключение нового проекта.

## Релизы

- [releases.md](releases.md) — версия продукта, стабильный канал и восстановление после ошибки обновления.
- [release-notes-template.md](release-notes-template.md) — шаблон заметок к GitHub Release.

`CLAUDE.md` — общий вход для всех исполнителей: Claude Code загружает строки `@...`
сам, а `AGENTS.md` направляет по тем же ссылкам исполнителей без такого синтаксиса.
Скрытой копии документации или отдельного каталога памяти у проекта нет.

Целостность относительных ссылок проверяет:

```bash
node --test tests/docs/*.test.mjs
```

Все безопасные проверки перечислены в [tests/README.md](../tests/README.md).
