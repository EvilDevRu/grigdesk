# Kimi в Factory: spike batch-режима и статус внедрения

Дата spike: 2026-08-02. Наблюдавшийся CLI: `kimi` 0.31.1
(`~/.kimi-code/bin/kimi`).
План — локальный черновик `docs/plans/kimi-factory-runner-plan.md` (вне репозитория).
Generic-контракт: [ADDING-RUNNER.md](ADDING-RUNNER.md).

Статус: **SPIKE_COMPLETE с оговорками (см. «Не доказано»). Раннер
`engine/lib/runners/kimi.sh` реализован (2026-08-02, TDD: тесты → критика тестов →
реализация), offline suite зелёный. До live-допуска (Stage 3 плана) раннер в боевые
цепочки не включать.**

## Методика spike

Ручные прогоны `kimi -p <prompt> --output-format stream-json` в изолированном каталоге
(`/tmp/kimi-runner-spike`, после spike удаляется), минимальные безобидные промпты.
Обезличенные результаты — `tests/engine/fixtures/classifiers/kimi-*` (PROVENANCE=runtime-spike).

## Формат событий stream-json (доказано)

Поток NDJSON в stdout, одна строка = одно событие. Наблюдаемые формы:

| Форма | Пример | Семантика |
|---|---|---|
| `{"role":"assistant","content":"..."}` | финальный текст | model activity |
| `{"role":"assistant","tool_calls":[{"type":"function","id":"tool_…","function":{"name":"Write","arguments":"…"}}]}` | вызов инструмента | tool activity |
| `{"role":"tool","tool_call_id":"tool_…","content":"…"}` | результат инструмента | tool activity |
| `{"role":"meta","type":"session.resume_hint","session_id":"…","command":"kimi -r …"}` | всегда последняя строка | мета, не активность |

stderr пуст при успехе; при ошибках запуска — одна строка `error: failed to run prompt: …`.
stdout содержит **только** поток CLI — обёртка раннера не должна писать в stdout ничего.

Промпт передаётся **только аргументом** `kimi -p "<prompt>"`: форма `-p -` stdin не читает
(доказано прогоном — модель получила пустое сообщение, rc=0). Практический предел —
ARG_MAX (~2 МБ на argv+env); конвейерные промпты на порядки меньше, отдельной защиты
не делаем.

## Permissions в headless (ключевой результат)

**Batch-режим по умолчанию выполняет всё без вопросов.** Доказано: без единого флага
`kimi -p` выполнил и `Write` (создание файла), и `Bash` (shell-команда) — rc=0, без
запросов и без зависаний. Флаги `-y/--yolo` и `--auto` описывают поведение
интерактивных режимов; в batch дефолт уже permissive. Промежуточного режима
«правки да, деструктивные нет» у `-p` нет.

Следствие: permission-политика раннера = «всё разрешено», деструктивные команды
ограничены только моделью. Это принятый риск редакции 2 плана (голый запуск, как из
терминала), записанный оператором. Зависания в ожидании ответа не происходит —
headless-пригодность подтверждена.

## Exit codes и сигнатуры

| Случай | rc | Сигнатура | Статус |
|---|---|---|---|
| Успех (включая tool calls) | 0 | events: assistant/tool + resume_hint | доказано |
| Нет логина (`KIMI_CODE_HOME` без credentials) | 1 | stderr: `No model configured. Run \`kimi\` and use /login to sign in…` | доказано, fixture `kimi-no-login` |
| Несуществующая модель (`-m`) | 1 | stderr: `config.invalid: Model "…" is not configured in config.toml` | доказано, fixture `kimi-bad-model` |
| SIGTERM во время хода | 143 | events может быть пустым, если TERM до первого события | доказано, fixture `kimi-interrupted` |
| Weekly/subscription limit | — | **не снято** (живьём не воспроизводится по команде) | НЕ доказано |
| 5h rate window / голый 429 | — | не снято | НЕ доказано |
| 401/403 от API (протухший токен) | — | не снято (нужен протухший credential) | НЕ доказано |
| 413 / context overflow | — | не снято | НЕ доказано |
| Network error | — | не снято: CLI игнорирует `HTTP(S)_PROXY` (прогон с битым прокси ответил rc=0) | НЕ доказано |

**Ограничение classify v1:** сигнатуры лимитов и 401/403 от API не доказаны, поэтому
классификатор их НЕ содержит. Лимит Kimi уйдёт в `unknown` → стадия не переключится,
run встанет в STALLED до человека. Это fail-closed и осознанно: при первом живом
инциденте снять stderr/events (PROVENANCE=runtime), добавить fixture и сигнатуру.
Доказанная сигнатура `No model configured … /login` (незалогиненный CLI) классифицируется
как `provider_unavailable` — только при доказанном отсутствии model/tool activity
(пустой events.jsonl), по инварианту ADDING-RUNNER.md.

## Прерывание (доказано)

TERM по обёртке (`timeout`) → процесс умирает чисто, rc=143, остаточных процессов нет.
CLI не создаёт собственную сессию: дерево остаётся в setsid-сессии launcher'а, штатный
quiesce достаточен, `runner_kimi_interrupt` = `return 0`. Внимание: на хосте живут
долгоживущие `kimi acp` процессы чат-рантайма Cockpit — убивать по имени процесса
нельзя, только по сессии/PGID (launcher так и делает).

## Статусный канал (доказано по примитивам)

env наследуется: агент через `Bash` видит `FACTORY_*` переменные родителя
(fixture: `printenv FACTORY_PROBE` → значение дошло). Shell выполняется без вопросов.
Значит `bash $FACTORY_HOME/lib/stage-result.sh done` достижим для агента в
request-транспорте (`status_request`); end-to-end коммит результата проверяется
integration-тестами с fake-раннером, не живым CLI.

## Startup inventory (зафиксирован)

`KIMI_CODE_HOME` (по умолчанию `~/.kimi-code/`): `config.toml` (default_model,
`[providers."managed:kimi-code"]` oauth, 4 модели), `credentials`, `oauth/`, `sessions/`,
`session_index.jsonl`, `logs/`, `telemetry/`, `workspaces.json`, `bin/` (CLI + `kimi.bak`
после self-update). При пустом `KIMI_CODE_HOME` CLI создаёт `config.toml`, `logs/`,
`updates/`, `device_id`, `migrations-effort.json`. Раннер запускает CLI с per-run
`KIMI_CODE_HOME` (`$run_dir/kimi-home`, см. «Effort через per-run home»): symlink
`credentials`/`oauth` + копия `config.toml`, остальное CLI пересоздаёт на запуск.
Skills без `--skills-dir`
подхватываются auto-discovery из user и project каталогов (по `--help`) — раннер
наследует это поведение, как запуск из терминала (принятый риск).

## Каталог и совместимость CLI

Версия CLI **не является допуском**. `probe` требует доступный `kimi` и успешный
`kimi --version`, а наблюдаемую версию сохраняет в metadata конкретного provider run
для диагностики. Обновление между узлами маршрута допустимо: immutable-контракт
попытки закрепляет маршрут и входы, но не исполняемый CLI.

Граница безопасности здесь не semver, а протокол движка:

- успех этапа принимается только через run-scoped CAS `stage-result`;
- известная отказная сигнатура применяется лишь при доказанном отсутствии
  assistant/tool activity;
- новая или изменившаяся форма отказа классифицируется `unknown`, поэтому не вызывает
  автоматический failover и повторное выполнение стадии;
- версия остаётся в `meta.env`, то есть расследование не теряет фактический runtime.

Это гарантирует корректность оркестрации, а не одинаковое качество модели или побочные
особенности CLI во всех релизах. `kimi upgrade` может менять их; если изменение не ломает
доказанный протокол, Factory его специально не блокирует.

Модели (из `config.toml`, `kimi provider list`: `managed:kimi-code`, source=oauth,
default `kimi-code/k3`): `kimi-code/k3`, `kimi-code/k3-256k`, `kimi-code/kimi-for-coding`,
`kimi-code/kimi-for-coding-highspeed`. Каталог раннера — pinned models.tsv с этими id.
Границы совместимости runtime в этих строках — `*/*`: список моделей закреплён
адаптером, но semver CLI его не выключает.

Effort: argv-флага и env-переменной у `-p` нет (по `--help`), но `[thinking].effort`
из config.toml применяется — см. «Effort через per-run home» ниже.

## Effort через per-run home (доказано 2026-08-03)

Spike (тот же протокол, что основной; каталог `/tmp/kimi-effort-spike`, удалён после):

- `KIMI_CODE_HOME=<per-run>` с symlink `credentials`/`oauth` на дефолтный home и копией
  config.toml: `kimi -p … --output-format stream-json` → rc=0, события `assistant` +
  terminal `session.resume_hint`, stderr пуст. Per-run home рабочий, credentials
  symlink-ами достаточно.
- Валидные значения `[thinking].effort` (`low`, `max`) переживают запуск — config.toml
  не переписывается.
- **Невалидное значение CLI не отвергает**: `effort = "bogus"` → rc=0, модель отвечает,
  а config.toml молча переписывается в `effort = "high"` (след — `migrations-effort.json`).
  Поэтому набор `low|high|max` пиннутого CLI валидирует сам раннер, fail-closed rc 4 до
  вызова модели (иначе мусорный пин незаметно деградирует в high).
- Effort в событиях stream-json не наблюдается: доказательство применения — принятие
  валидных значений и сохранность конфига, а не поле в потоке.

Реализация: `runner_kimi_run` собирает `$run_dir/kimi-home` (копия config.toml с
переписанной секцией `[thinking]` — блоки моделей с их `default_effort` не трогаются;
`credentials`/`oauth` symlink) и запускает CLI с `KIMI_CODE_HOME` на него. Пустой
effort → конфиг копируется без правки (наследуется дефолтный home). Пины —
`MODEL_<СТАДИЯ>_KIMI_EFFORT` / `MODEL_DEFAULT_KIMI_EFFORT` в runners.env, как у
других провайдеров.

## Принятые риски (наследуют риски редакции 2 плана)

- Голый запуск: env/ФС/сеть хост-пользователя без OS-границы; деструктивные команды
  не ограничены ничем, кроме модели.
- Egress не фильтруется (CLI к тому же игнорирует proxy env).
- Общий credential file с чат-рантаймом Cockpit; гонки OAuth refresh — наблюдать в live.
- Auto-discovery skills/config из home и project каталогов — как у запуска из терминала.
- CLI может обновиться между узлами одной route-attempt; фактическая версия каждого
  provider run записывается, а незнакомый отказ остаётся `unknown` без автоповтора.
