# Обновление upstream DeepSeek и совместимый откат

Выбранные upstream bytes остаются неизменными в кэше `deepseek/vendor/deepseek-harness/upstream/`
(вне Git, подготавливается по manifest). Host composition и launcher находятся вне снимка;
патчи применяются только к сборочной копии. Manifest закрепляет repository, полный SHA,
version, selection, SHA-256 файлов и обязательные gates. Плавающие refs и автоматические
commits не используются; в commit обновления попадают manifest, патчи и лицензии.

## Подготовка и review исходников

Из корня GrigDesk, после выбора конкретного upstream commit:

```bash
UPSTREAM_SHA='<полный-40-символьный-SHA>'
SYNC_DIR=$(mktemp -d "$HOME/.grigdesk/artifacts/deepseek-sync.XXXXXX")
node deepseek/scripts/syncDeepSeekHarness.mts --commit "$UPSTREAM_SHA" \
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
node deepseek/scripts/syncDeepSeekHarness.mts --commit "$UPSTREAM_SHA" \
  --publish "$SYNC_DIR/candidate.json"
```

Publish повторяет integrity/patch gates, строит настоящий runtime и выполняет
compiled web/ACP loopback проверки. Отказ сохраняет прежний snapshot. Команда
не активирует runtime и не делает commit/push. MIT copyright и LICENSE сохраняются;
native/npm notices и LGPL/GPL supplements учитываются в license inventory.

## Сборка и установка выпуска

Исходный snapshot принадлежит пакету `deepseek/`; GrigDesk в production его не читает.
Source publication gate собирает ELF выбранного candidate и запускает package/unit/SEA
и обязательные compiled web/ACP/GLM проверки. Полный порядок —
[README пакета](../../../deepseek/README.md) и [гейты](../testing/deepseek-test-gates.md).
После явной подготовки pinned dependencies и snapshot:

```bash
npm --prefix deepseek run build -- --out-dir /absolute/release
npm --prefix deepseek run install:binary -- --binary /absolute/release/deepseek \
  --target bin/deepseek --host-contract server/deepseek-host-contract.json
```

Установщик проверяет metadata, host contract, GLM admission и полный payload того же
staged ELF, который затем публикуется через atomic rename. Предыдущий установленный
ELF сохраняется. Текущий ход A заканчивается на A; последующие получают B без пересборки
и перезапуска GrigDesk. Обновление самого GrigDesk не собирает и не заменяет Harness.
Проверка совместимости новых upstream требует review, compiled gates и отдельного живого
допуска изменившегося GLM compatibility. Loopback сам по себе живой допуск не даёт.

## Откат и данные сессий

Откат — та же команда установки с прежним ELF. Отдельных activation и fork команд нет.
Home разговора стабилен: `<runtimeHome>/chats/<sha256(chatKey)>`, отдельно для DeepSeek и GLM.
Версия сборки, packageId и compatibility не выбирают новый home. Читаемый журнал позволяет
A→B→A продолжить прежнюю sessionId; модель получает предыдущие ходы. Профиль прав меняется
при смене прав, ключа, режима, модели или cwd по прежним правилам, а не при замене ELF.

Перед resume проверяется самый новый физический canonical номер журнала, включая v0.
Если reader не поддерживает этот номер, чат через CAS создаёт новую сессию с заметкой,
сохраняя старый журнал, ленту и pendingSeed. Отсутствующий или повреждённый журнал даёт
отказ; скрытого повторного выполнения prompt нет. Установщик предупреждает, если writer
нового ELF не читается прежним reader, но не копирует и не архивирует homes.

Первый переход переносит DeepSeek home по buildId установленной legacy generation,
GLM — по прежней compatibility. Соседние identities остаются на месте; атомарный receipt
позволяет закончить прерванный перенос. При совпадении прежнего security profile CAS
сохраняет sessionId. [Первый переход](deepseek-binary-cutover.md) проверяется отдельно.
Откат с новой схемы homes на embedded не поддерживается.

Общие prefs сохраняют format 1, field IDs, values и CAS. Удалённые или изменившие тип
поля остаются inactive и допускают reset без доступного источника.
Поддержка произвольного будущего формата журнала не обещается.
