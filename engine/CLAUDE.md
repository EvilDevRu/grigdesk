# Engine — движок конвейера (инструкции для агента)

Движок фабрики задач — **часть кокпита** и канонически живёт в каталоге `engine/`.
Кокпит — пульт (запускает `engine/bin/factory`, читает реестры), движок — станок.
Внешний checkout не является источником кода; он подключается только явными env-override.
Общение и комментарии в коде — **только на русском**.

Несмотря на имя файла, эти правила общие для Claude Code, Codex и любого другого
исполнителя движка.

## Прежде чем что-то менять — прочитай

| Документ | О чём |
|---|---|
| [../docs/engine/ENGINE.md](../docs/engine/ENGINE.md) | **как менять этот репозиторий**: инварианты, карта файлов, когда правка вступает в силу, чем проверяться, ловушки |
| [../docs/engine/PROFILE-CONTRACT.md](../docs/engine/PROFILE-CONTRACT.md) | что движок ждёт от профиля проекта (переменные, хуки, протокол статусов) |
| [../docs/engine/NEW-PROJECT.md](../docs/engine/NEW-PROJECT.md) | как завести конвейер под новый проект — с вопросами, которые надо задать человеку |
| [../docs/engine/ADDING-RUNNER.md](../docs/engine/ADDING-RUNNER.md) | как добавить нового ИИ-исполнителя (раннера): контракт, TDD-порядок, тесты, live-допуск |
| [../docs/engine/DEEPSEEK.md](../docs/engine/DEEPSEEK.md) | pinned DeepSeek Harness: ACP, файловые режимы, permissions, Factory status и доказательства live |
| [README.md](README.md) | что это вообще такое и как выглядит для человека |

При работе с локальным `../profiles/<имя>/` сначала прочитай его `README.md`, если файл
существует, и документы рядом с изменяемой частью профиля, например `routes/README.md`.
Профиль исключён из Git, поэтому его машинно- и проектно-зависимые факты не переносятся
в документацию общего движка.

## Три правила, нарушение которых ломает всё

1. **Движок не знает ни одного проекта.** Имена контейнеров, команды стека, пути репозиториев —
   только в локальном `../profiles/<имя>/profile.sh`; весь `/profiles/` игнорируется Git,
   новых исключений не добавлять.
2. **Агент завершает этап только через `lib/stage-result.sh`.** Нетерминальные маршрутные
   данные идут через `lib/stage-progress.sh`; прямой pipeline writer агенту не выдаётся.
   Хостовый `executor=command` вместо этого печатает JSON-вердикт в stdout — его форму
   (`findings` только при `failed`, `id` уникальны) обязан проверять тест профиля прогоном
   через `_route_v2_command_result`, а не сверкой одного лишь JSON скрипта. Рассинхрон здесь
   не отклоняет поле, а останавливает маршрут кодом 78 на уже отработавшем узле.
3. **Документация правится вместе с кодом.** Новый или удалённый хук — в тот же заход в
   `../docs/engine/PROFILE-CONTRACT.md`. Комментарии-объяснения причин («так возникает
   гонка слотов») не удалять: это оплаченный инцидентами контекст.

## Проверки перед тем, как сказать «готово»

```bash
bash -n bin/factory bin/factory-check lib/*.sh ../profiles/*/profile.sh
python3 -m py_compile lib/dashboard.py
bin/factory-check --quick        # все профили: capability/hooks, runner config, paths/host
../tests/run-all.sh              # полный offline suite, без Cockpit и model call
```

Коммит и пуш — только по явной просьбе человека.

## Что где лежит

```
bin/      factory (CLI+демон), factory-route/context, dashboard, factory-check
lib/      core.sh (ядро), multi-runner.sh (dispatcher), run-state.sh (protocol v2), dashboard.py
../profiles/<имя>/ локальные profile.sh + обязательные runners.env/graph.json/dashboard.env +
                    routes/ и проектные stand-скрипты; каталог целиком вне Git
../tests/engine/ проверки движка, профилей и дашборда
```

Состояние задач — вне репозитория: `~/.factory/state/` (`tNNNN.pipeline`, `logs/`, `archive/`,
`shots/`, `quarantine/`). Путь берётся из `FACTORY_STATE`/`STATE_DIR`, хардкодить нельзя.

Движок запускает и читает **кокпит** из корня текущего checkout — меняя формат
реестра, вывод `factory slots` или переменные профиля, проверь и его.
