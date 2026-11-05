# Документация GrigDesk

Документация хранится отдельно от исполняемого кода и группируется по подсистемам.
Текущую архитектуру описывают документы движка, работу с продуктом — `grigdesk/guide/`, а
устройство и грабли GrigDesk — папки областей `grigdesk/<область>/` с README-оглавлением.

Общая документация описывает продукт и контракты, но не перечисляет реальные подключённые
проекты: без их названий, доменов, стеков, task ID и конкретных путей в `profiles/`.
Проектная конкретика хранится только в локальном `profiles/<name>/README.md`; в общих
примерах используются `<PROFILE>`, `<TASK>` и названия режимов `isolated`/`shared`.

Общая документация описывает то, что уже внедрено. Снятые решения сохраняются с явной
пометкой истории; описанные в них команды и API не являются действующим контрактом.

Опыт конкретной машины: рабочие проекты, номера задач и прочее,
чему не место в публичном репозитории, лежит в `docs/local/`. Этот каталог Git
игнорирует, и ссылаться на него из канона можно только текстом.

## Устройство и грабли по областям

Каждая область — папка с README-оглавлением: контракты продукта, устройство и грабли по
строке на документ. Документ читается по ссылке, когда задача касается области.
Имена файлов — короткие английские `kebab-case.md`, без транслита; заголовки и текст — русские.
Правила актуальности, обезличивания и выборочного чтения — в
[порядке поддержки документации](grigdesk/overview/documentation-maintenance.md).
Происхождение корпуса описывает [история переноса знаний](grigdesk/overview/documentation-migration.md).

- [Устройство GrigDesk](grigdesk/overview/README.md) — слои, модули сервера, принципы.
- [Чат и исполнители](grigdesk/chat/README.md) — чат, модели, права, контекст, MCP.
- [Конвейер](grigdesk/pipeline/README.md) — фабрика, маршруты, граф, ворота, арбитр.
- [Задачи Б24](grigdesk/b24/README.md) — портал, статусы, доска и полка.
- [Входящие](grigdesk/inbox/README.md) — общий автомат, Telegram и GitHub Issues.
- [Telegram-пульт](grigdesk/telegram/README.md) — вотчер, действия, ассистент.
- [Интерфейс](grigdesk/web/README.md) — раскладка, слои, всплывашки и пакет приложения.
- [Сервер и доступ](grigdesk/server/README.md) — запуск, авторизация, основной HTTP на loopback
  и отдельно включаемый клиентский TLS-вход.
- [Приложение на телефоне](grigdesk/mobile/README.md) — полный клиент, локальная труба,
  привязка, сборка APK и совместимость с прежним v1.
- [Видео и речь](grigdesk/media/README.md) — записи встреч, расшифровка, речь.
- [Плагины](grigdesk/plugins/README.md) — SSH, документы, «Код», стенды, презентации.
- [Тесты и проверка](grigdesk/testing/README.md) — happy-dom, Playwright, ловушки.

## Работа с GrigDesk

- [guide/tasks.md](grigdesk/guide/tasks.md) — как оформить задачу и что с ней делает триаж.
- [guide/gates.md](grigdesk/guide/gates.md) — где конвейер останавливается и чего ждёт от человека.
- [guide/projects.md](grigdesk/guide/projects.md) — паспорт проекта, его репозитории и API раздела.
- [guide/routes.md](grigdesk/guide/routes.md) — черновики маршрутов, проверка, публикация и откат.
- [reference/runtime-contracts.md](grigdesk/reference/runtime-contracts.md) — SSH-плагин, надзорный
  доступ к базам и Telegram-пульт.

## Движок фабрики

- [MULTI-AI.md](engine/MULTI-AI.md) — статус и контракт мульти-ИИ, failover и диагностики.
- [ENGINE.md](engine/ENGINE.md) — архитектура движка, инварианты и проверки.
- [KIMI.md](engine/KIMI.md) — Kimi runner, классификация отказов и contract-based совместимость CLI.
- [GLM.md](engine/GLM.md) — GLM runner этапов поверх DSH ELF: допуск, каталог, fail-closed классификатор.
- [ADDING-RUNNER.md](engine/ADDING-RUNNER.md) — подключение нового provider runner.
- [PROFILE-CONTRACT.md](engine/PROFILE-CONTRACT.md) — контракт проектного профиля.
- [Профили конвейера](grigdesk/pipeline/project-profiles.md) — устройство и справочник
  параметров файлов, хуков, исполнителей, моделей и маршрутов.
- [NEW-PROJECT.md](engine/NEW-PROJECT.md) — подключение нового проекта.

## Релизы

- [releases.md](releases.md) — версия продукта, стабильный канал и восстановление после ошибки обновления.
- [release-notes-template.md](release-notes-template.md) — шаблон заметок к GitHub Release.

`CLAUDE.md` — общий вход для всех исполнителей: Claude Code загружает строки `@...`
сам, а `AGENTS.md` направляет по тем же ссылкам исполнителей без такого синтаксиса.
Единственная строка `@` в нём ведёт в локальный `CLAUDE.local.md` со ссылкой на опыт
машины в `docs/local/`: этого файла в репозитории нет, и его отсутствие — штатное состояние клона.

Целостность относительных ссылок проверяет:

```bash
NODE_TEST_MAX_RSS_MB=4096 bash tests/run-node-tests-safe.sh \
  --test --test-concurrency=2 tests/docs/*.test.mjs tests/docs/*.test.mts
```

Все безопасные проверки перечислены в [tests/README.md](../tests/README.md).
