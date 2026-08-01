# Engine — движок конвейера (инструкции для агента)

Движок фабрики задач — **часть кокпита** и канонически живёт в каталоге `engine/`.
Кокпит — пульт (запускает `engine/bin/factory`, читает реестры), движок — станок.
Внешний checkout не является источником кода; он подключается только явными env-override.
Общение и комментарии в коде — **только на русском**.

## Прежде чем что-то менять — прочитай

| Документ | О чём |
|---|---|
| [../docs/engine/ENGINE.md](../docs/engine/ENGINE.md) | **как менять этот репозиторий**: инварианты, карта файлов, когда правка вступает в силу, чем проверяться, ловушки |
| [../docs/engine/PROFILE-CONTRACT.md](../docs/engine/PROFILE-CONTRACT.md) | что движок ждёт от профиля проекта (переменные, хуки, протокол статусов) |
| [../docs/engine/NEW-PROJECT.md](../docs/engine/NEW-PROJECT.md) | как завести конвейер под новый проект — с вопросами, которые надо задать человеку |
| [README.md](README.md) | что это вообще такое и как выглядит для человека |

## Три правила, нарушение которых ломает всё

1. **Движок не знает ни одного проекта.** Имена контейнеров, команды стека, пути репозиториев —
   только в локальном `../profiles/<имя>/profile.sh`; весь `/profiles/` игнорируется Git,
   новых исключений не добавлять.
2. **Агент завершает этап только через `lib/stage-result.sh`.** Нетерминальные маршрутные
   данные идут через `lib/stage-progress.sh`; прямой pipeline writer агенту не выдаётся.
3. **Документация правится вместе с кодом.** Новый или удалённый хук — в тот же заход в
   `../docs/engine/PROFILE-CONTRACT.md`. Комментарии-объяснения причин («так возникает
   гонка слотов») не удалять: это оплаченный инцидентами контекст.

## Проверки перед тем, как сказать «готово»

```bash
bash -n bin/factory bin/factory-check bin/factory-new lib/*.sh ../profiles/*/profile.sh
python3 -m py_compile lib/dashboard.py bin/factory-graph-new
bin/factory-check --quick        # все профили разом: контракт, промпты, доступы, схема, скорость
../tests/run-all.sh              # полный offline suite, без Cockpit и model call
```

Коммит и пуш — только по явной просьбе человека.

## Что где лежит

```
bin/      factory (CLI+демон), dashboard, factory-new (скелет профиля),
          factory-graph-new (заготовка схемы конвейера), factory-check (проверки)
lib/      core.sh (ядро), multi-runner.sh (dispatcher), run-state.sh (protocol v2), dashboard.py
../profiles/<имя>/ локальные profile.sh + обязательные runners.env/graph.json/dashboard.env +
                    проектные скрипты; каталог целиком вне Git
../tests/engine/ проверки движка, профилей и дашборда
```

Состояние задач — вне репозитория: `~/.factory/state/` (`tNNNN.pipeline`, `logs/`, `archive/`,
`shots/`, `demo/`, `quarantine/`). Путь берётся из `FACTORY_STATE`/`STATE_DIR`, хардкодить нельзя.

Движок запускает и читает **кокпит** (`~/Workspace/cockpit`) — меняя формат реестра, вывод
`factory slots` или переменные профиля, проверь и его.
