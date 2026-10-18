# Обновление upstream DeepSeek и совместимый откат

Выбранные upstream bytes остаются неизменными в кэше `third_party/deepseek-harness/upstream/`
(вне Git, подготавливается по manifest). Host composition и launcher находятся вне снимка;
патчи применяются только к сборочной копии. Manifest закрепляет repository, полный SHA,
version, selection, SHA-256 файлов и обязательные gates. Плавающие refs и автоматические
commits не используются; в commit обновления попадают manifest, патчи и лицензии.

## Подготовка и review исходников

Из корня GrigDesk, после выбора конкретного upstream commit:

```bash
UPSTREAM_SHA='<полный-40-символьный-SHA>'
SYNC_DIR=$(mktemp -d "$HOME/.grigdesk/artifacts/deepseek-sync.XXXXXX")
node tools/syncDeepSeekHarness.mts --commit "$UPSTREAM_SHA" \
  --staging-parent "$SYNC_DIR" --candidate "$SYNC_DIR/candidate.json"
```

Команда получает именно Git object выбранного SHA. Для offline source допустим
`--source-dir <абсолютный-путь-к-Git-репозиторию>`. Candidate recipe и diff доступны
для review. Проверяются ручные изменения старого снимка, безопасные пути, удаления,
зависимости и применимость патчей. Конфликт патча останавливает подготовку.
Неизвестный dynamic import или новый dependency требует обновления composition
и повторной проверки closure, а не обхода gate.

После просмотра diff, copyright/licenses, схем обоих consumers и обновления
согласованных host contracts оператор публикует snapshot отдельно:

```bash
node tools/syncDeepSeekHarness.mts --commit "$UPSTREAM_SHA" \
  --publish "$SYNC_DIR/candidate.json"
```

Publish повторяет integrity/patch gates, строит настоящий runtime и выполняет
compiled web/ACP loopback проверки. Отказ сохраняет прежний snapshot. Команда
не активирует runtime и не делает commit/push. MIT copyright и LICENSE сохраняются;
native/npm notices и LGPL/GPL supplements учитываются в license inventory.

## Сборка и активация

Обычная доставка происходит вместе с GrigDesk. Для явной проверки generation
оператор может собрать candidate без изменения current:

```bash
GENERATION="$SYNC_DIR/generation"
node tools/buildDeepSeekRuntime.mts --output-dir "$GENERATION"
GRIGDESK_TEST_DEEPSEEK_ARTIFACT="$GENERATION" NODE_TEST_MAX_RSS_MB=4096 \
  bash tests/run-node-tests-safe.sh --test --test-concurrency=2 \
  tests/server/deepseek-vendor-build.test.js \
  tests/server/deepseek-acp-settings.test.js \
  tests/server/deepseek-vendored-chat.test.js \
  tests/server/deepseek-factory-settings.test.js
node tools/publishDeepSeekRuntime.mts --generation "$GENERATION" \
  --runtime-root "$PWD/server/runtime/deepseek"
```

Нужны заранее подготовленные exact compiler dependencies; общий шаг
`npm --prefix server run deepseek:prepare` устанавливает их и готовит текущий runtime.
BuildId учитывает composition, patches, dependency lock, platform/ABI и payload; сборка
воспроизводима, поэтому неизменные входы дают прежний buildId. Обновление GrigDesk без
изменений DeepSeek повторно использует установленное поколение: update worker предлагает его
target prepare, и тот отвечает `reused` без npm ci, сборки и публикации. Смена сборки
инвалидирует native/model catalogs, settings/security/session bindings и Factory coverage:
чат начинает новую сессию с заметкой «профиль исполнителя изменился», конвейер один раз
повторяет host preflight. Новые узлы проверяют актуальную identity. Уже запущенный
процесс A остаётся на A при публикации B. Неоднозначный `runtime_changed` запрещает
prompt и автоматический failover.

## Откат и данные сессий

Старые поколения не удаляются автоматически. Для совместимого host/journal contract:

```bash
node tools/activateDeepSeekRuntime.mts \
  --runtime-root "$PWD/server/runtime/deepseek" --build-id <старый-buildId>
```

Activation повторно проверяет hashes, contract и Node/native ABI. Несовместимый
артефакт отвергается до смены current; несовместимый host требует отката согласованного
релиза GrigDesk. Pending update сначала восстанавливается по
[контракту публикации](../server/deepseek-release-transition.md).

Публикация, activation и fork проверяют artifact асинхронно, сохраняя
[обработку heartbeat уже работающего A](deepseek-publication-event-loop.md).

Приватные homes разделены по buildId. Новый build не изменяет прежний home;
новая runtime session может получить сохранённую историю GrigDesk. Общие prefs
сохраняют format 1, field IDs, values и CAS. Удалённые/изменившие тип поля остаются
inactive и допускают reset без доступного источника.

Для явно проверенного переноса журналов сначала остановить использование выбранного
home, создать отдельную копию и закрепить её за поколением:

```bash
node tools/forkDeepSeekHome.mts \
  --source-home <абсолютный-исходный-home> \
  --destination-home <новый-абсолютный-home> \
  --generation <абсолютное-проверенное-поколение>
```

Fork не перезаписывает существующий destination, запрещает внешние ссылки и
вложенную копию, проверяет неизменность источника во время копирования. Оригинал
сохраняется. Host `journalFormat: 1` — политика совместимости артефакта; upstream
сейчас использует настоящий journal codec v3. Resume B-журнала в совместимой A-копии
доказан actual runtime с loopback API. Fixture будущего v99 отвергается до model call,
с сохранением оригинальных bytes. Это не обещание поддержки будущего формата.
Если новые записи нельзя перенести назад, сохранить историю GrigDesk и открыть новую
runtime session; старая копия не считается полным продолжением новых ходов.

Проверены Linux x64/glibc, Node 22.22.1 и loopback model API. Реальный платный API,
другие платформы и операторский restart этой приёмкой не проверялись.
