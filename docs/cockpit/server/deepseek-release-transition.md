# Встроенный DeepSeek: публикация и переход updater

Production source использует `server/deepseek-runtime-contract.json` с
`format: 1`, `publishContract: 1`, `mode: embedded`. Runtime собирается общей
подготовкой Cockpit. Отдельная установка Harness пользователем не нужна.

## Переход со старой установки

Worker обновления исполняется из установленного релиза. Прежний worker переносит
только `web/dist` и `server/node_modules`; поэтому переход требует двух выпусков:

1. Промежуточный релиз с `mode: installed` и новым worker с publish contract 1.
2. Embedded-релиз, требующий этот контракт в target smoke до изменения checkout.

Промежуточный публичный tag/SHA пока не выпущен. Перед выпуском embedded maintainer
должен выпустить промежуточный релиз и записать его точные tag/SHA в release notes.
Проверки в disposable repositories доказывают переход неизменённым legacy worker;
они не означают публикацию этих релизов. Прямой legacy → embedded останавливается
на `smoke_test_failed`, сохраняя checkout и каталоги. Marker принадлежит worker,
его нельзя добавлять в глобальное окружение службы.

Если оба тега уже опубликованы, старый интерфейс выбирает только latest. Оператор
сначала устанавливает точный промежуточный релиз. В чистой ветке `main`, из корня:

```bash
INTERMEDIATE_TAG=vX.Y.Z
INTERMEDIATE_SHA='<полный-SHA-из-release-notes>'
git fetch --no-tags origin "refs/tags/$INTERMEDIATE_TAG"
test "$(git cat-file -t FETCH_HEAD)" = tag
test "$(git rev-list -n 1 FETCH_HEAD)" = "$INTERMEDIATE_SHA"
BOOTSTRAP=$(mktemp /tmp/cockpit-upgrade.XXXXXX)
git show "$INTERMEDIATE_SHA:tools/upgrade-publish-contract" > "$BOOTSTRAP"
COCKPIT_UPGRADE_ROOT="$PWD" bash "$BOOTSTRAP" \
  --tag "$INTERMEDIATE_TAG" --sha "$INTERMEDIATE_SHA"
rm "$BOOTSTRAP"
```

Подставляются опубликованные значения. Скрипт проверяет annotated tag/SHA,
чистоту, ветку `main`, допустимость fast-forward и installed publish contract;
затем выполняет штатные `bin/cockpit deps` и `build`. Dirty/diverged checkout
останавливает процедуру без reset или очистки. После ручного restart оператора
обычная кнопка обновления может установить embedded-релиз.

Неизменённый legacy worker без systemd перезапускает сервер через `bin/restart`. Скрипт
переехал в `deploy/restart.sh`, поэтому у такой установки обновление проходит, а шаг
перезапуска завершается отказом: сервер перезапускают руками. Под systemd legacy worker
перезапускает юнит и переезда не замечает.

## Публикация generation

Новый worker запускает target prepare в собственном archive directory и предлагает ему
установленное поколение (`COCKPIT_DEEPSEEK_REUSE_RUNTIME`) и кэш исходников установки
(`COCKPIT_DEEPSEEK_UPSTREAM_SEED`). Если входы сборки не менялись, prepare отвечает
`{"reused": true, "buildId": …}`: worker берёт установленный current как ожидаемый, ничего
не публикует, не пишет pending и не загружает publisher. Иначе target собирает новое
поколение (исходники копируются из кэша установки, если совпал manifest, иначе по сети),
а worker проверяет Node/native compatibility и полный artifact, сохраняет предыдущие
SHA/buildId и ожидаемый buildId. Publisher (`tools/deepseekRuntimePublication.ts`) worker
загружает один раз из установленного дерева сразу после сборки runtime, до
fast-forward: после него тот же путь указывает на код целевого релиза, и
публикация или откат смешали бы его с уже загруженным installed `runtimeArtifact`.
Перед fast-forward worker создаёт приватный (0600) `publish-pending.json` через
временный файл и rename, поэтому оборванная запись не оставляет нечитаемый маркер.
После публикации web, server dependencies и immutable generation проверяет копию
и атомарно переключает относительный `current`. Generation самодостаточна после
удаления staging; старые builds и приватные homes сохраняются. Сохранённая
generation с тем же buildId переиспользуется только целой: повреждённая заменяется
проверенной копией кандидата.

Повреждённый (`deepseek_runtime_corrupt`) или несовместимый
(`deepseek_runtime_incompatible`) прежний `current` не валит обновление: worker
пишет в журнал обновления строку `previous-runtime-unusable <код>`, считает, что
прежнего поколения нет (`previousRuntimeBuildId: null`) и продолжает — так
обновление чинит сломанный runtime. Откат при сбое публикации тогда снимает
`current`, как при отсутствующем прежнем поколении.

При отказе отдельного шага восстанавливаются каталоги, current и прежний checkout.
Если checkout изменён другим writer или восстановление не закончено, pending
сохраняется и новые embedded prompts запрещены. Обработчик сбоя снимает pending,
только если тот читается и принадлежит этому же job. `done` новый сервер
подтверждает по target SHA, expected buildId, integrity и совместимости host
contract. Один новый SHA при повреждённом runtime не означает успешное обновление.

## Чужой pending и lock публикации

Worker проверяет `publish-pending.json` в начале job, до установки зависимостей и
сборки, и повторно перед записью своего маркера. Маркер другого job останавливает
обновление с `runtime_publication_pending`; сообщение job называет команду
`--recover-job` с jobId из маркера (раздел ниже). Нечитаемый маркер тоже
останавливает обновление: команде восстановления нужен jobId, поэтому checkout и
runtime сверяются вручную по журналу обновления, и только после этого маркер
убирают. Чужой маркер worker не удаляет. Кнопка обновления pending пока не
учитывает: отказ приходит от worker, его текст показан в карточке job настроек.

Lock `.publish-lock` берётся `mkdir` и сразу получает `owner.json` с pid. Lock
после kill или Ctrl-C публикация снимает сама и повторяет захват один раз, если
процесс владельца завершился (`ESRCH`) или `owner.json` нет либо он битый, а lock
старше 60 с. Живой владелец (включая `EPERM` на проверку сигналом) даёт отказ
«Публикация runtime DeepSeek уже идёт (pid N)»; worker переносит этот текст в
сообщение `publish_failed`.

## Прерывание и восстановление

Update job хранит `publicationStage`, previous SHA/buildId и expected buildId.
Исчезнувший worker переводится в `failed/worker_disappeared`; pending остаётся.
Оператор сначала проверяет job и состояние checkout, затем для этого job выполняет:

```bash
node server/scripts/prepareDeepSeekRuntime.mts --recover-job <UUID-job>
```

Recovery допускает только чистый исходный или целевой checkout этого job и
завершившийся worker. Lock публикации с мёртвым владельцем снимает сама публикация,
lock живого чужого writer не удаляется. Команда повторно
подготавливает server/web dependencies и web, проверяет или собирает generation,
и только после успешного завершения снимает pending. Ошибка оставляет блокировку;
ручная очистка marker не является восстановлением. Далее оператор вручную
перезапускает Cockpit и перепроверяет readiness. Агент из чата restart не выполняет.

## Адресная проверка publish contract

```bash
COCKPIT_RELEASE_PUBLISH_CONTRACT=1 NODE_TEST_MAX_RSS_MB=4096 \
  bash tests/run-node-tests-safe.sh --test --test-concurrency=2 \
  tests/server/cockpit-release.test.js \
  tests/server/deepseek-update-transition.test.js \
  tests/server/deepseek-runtime-packaging.test.js
```

Legacy integration удаляет унаследованный marker: новый worker должен выставлять
его сам. Fixture тестирует оба latest tags, конкретный переход, каждый publish
failure и SIGKILL собственного worker до fast-forward. Publisher целевого релиза
в fixture намеренно бросает исключение при импорте: успех доказывает, что worker
публикует и откатывает installed-кодом. Отдельные сценарии проверяют непригодный
прежний current, чужой и нечитаемый pending (обёртка npm показывает, что worker не
дошёл до установки) и lock живого, завершившегося и безымянного владельца. Отдельный
clean build использует настоящие npm/native dependencies и проверяет запуск после
переноса.
