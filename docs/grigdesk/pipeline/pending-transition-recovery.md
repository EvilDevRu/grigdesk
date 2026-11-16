# Восстановление сохранённого перехода после отказа записи

Проверенный результат agent/command не требует нового вызова модели при временном отказе
фиксации. Хост сохраняет optional `pending-transition.json` в доверенном каталоге попытки
после filesystem guard и evidence hook. Stage ledger остаётся единственным источником
перехода курсора; run-state, отчёт агента и lifecycle не дают права принять `done`.

## Сохранение и повтор

`engine/lib/pending_transition.py` связывает task/attempt/profile/catalog/route/node,
исходные eventSequence/headEventHash, буквальные commit argv и SHA снимка workspace guard.
Receipt также связывает exact origin visit/session/runKey/ordinal, если lifecycle включён.
Файл публикуется атомарно с fsync файла/каталога, mode 0400; owner, canonical path,
single link и закрытая схема проверяются при чтении. Он находится вне writable state агента.

`engine/lib/pending-transition.sh` повторяет запись не более трёх раз только при rc1/74.
CAS 75, integrity 78 и отказы guard/evidence не повторяются. Достраивание проекции не
повторяет модель. Без нового event исходный CAS и fingerprint должны совпадать;
изменённое дерево или human rewind архивируют receipt и требуют нового исполнения.
Уже принятый exact event не отменяется последующим изменением исходников: для его
допроекции новый snapshot/workspace не нужны. Gate/SCOUT и административные переходы
не переводятся на pending wrapper.

## Event опубликован, runtime ещё нет

`attempt_stage_state_reconcile_pending_v2` берёт существующий task-state lock и отдельно
вызывает `recover-pending-runtime`. Полная цепочка, pins, checksum старого runtime и
семантика событий проверяются прежним владельцем ledger. Допускается только один
exact accepted tail над валидным prefix runtime и соответствующим host receipt.
Операция достраивает runtime pointer, не переписывая event. Общий strict reader ничего
не чинит и не получает ослабленной проверки.

Public `factory resume` сначала сверяет origin и immutable scope, затем выполняет
этот узкий reconcile до первого strict runner preflight read. Повреждённая/отсутствующая
runtime-проекция, лишние файлы, несколько хвостов или неподтверждённый origin остаются
fail-closed. Такую историю нельзя исправлять удалением событий или ручным курсором.

## Ожидание человека

Receipt сохраняется до UI projection и durable human record. Exact origin выбирается
из полного валидированного lifecycle ledger; adopt сохраняет writer session текущего
процесса и не меняет другой текущий visit. `human_begin_once` сначала находит существующий
exact question; повтор после append не генерирует другой timestamp/eventId.
Ack удаляет receipt только после доказательства проекции.

Восстановленный вопрос удерживает повторный resume без новой session, закрытия вопроса,
finish визита или модели. Это отдельный доказанный случай; ordinary legacy skipped,
exhausted, loop ceiling и прежний failed hold сохраняют свои правила. Lifecycle служит
здесь доказательством проекции/удержания, а не разрешением stage commit.

Новая попытка, созданная через recover, может ещё не иметь инициализированного cursor.
Документированный код reader 73 в read-only hold пропускает её к штатной инициализации.
Коды повреждения 78 и I/O 74 остаются отказами. Это не восстановление отсутствующего
runtime при наличии pending receipt: там прежний узкий proof обязателен.

Диагностика recovery пишется отдельной строкой, затем каноническая строка
`NODE: маршрут остановлен: human` либо другой поддержанный stop. Произвольный human suffix
нельзя добавлять без парного обновления server classifier: иначе теряются stage/comment
и открытие вопроса в интерфейсе. Failed/goto suffix не применяется к accepted done.

## Совместимость и поставка

Старые попытки без receipt идут прежним путём. Null origin допустим только без истории
lifecycle. Форматы stage и lifecycle событий не мигрируют. Новый node проверки стенда
появляется только в новом опубликованном маршруте; старый pin сам не меняется.
Receipt не является автоматическим downgrade-протоколом: перед откатом поставки
нужно отдельно решить судьбу незавершённой записи. Не менять runtime pin или каталог руками.

Ремонт стенда принадлежит профильной host command с явной capability. Профиль проверяет
собственность ресурсов, ограничивает бюджет и возвращает command verdict. Браузерный
агент не получает инфраструктурных прав. Переход failed/environment выбирается onFailure
закреплённого маршрута; productFailure не расходуется на такой исход.

## Проверки

- `tests/engine/unit/pending-transition.py`: CAS, exact event, source drift, чужая identity,
  immutable receipt и source origin.
- `tests/engine/integration/route-retry-wrapup.sh`: pre-append I/O, fresh shell, post-append
  projection, human rewind, guard/evidence, runtime gap и safety stops.
- `tests/engine/unit/runtime-analytics-reconciliation.sh`: validated origin/adopt,
  begin-once/ack, запрет чужого visit и повтор без lifecycle дублей.
- `tests/engine/contract/factory-launcher.sh`: настоящий public start/resume, wrong task/origin
  до эффектов, runtime gap, before/after human append; actual log/registry проходят
  server detectStall и графовые keys после первого восстановления и повторного hold.
- `tests/server/stall-human-stop.test.js`: сохранение canonical human/evidence/exhausted/failed
  и карточка восстановления; synthetic standalone не заменяет public artifacts.

Offline tests не доказывают actual UID/GID процессов, Docker restart, полный рабочий цикл
сервисов или живую кнопку интерфейса. После установки это проверяют на отдельном disposable
стенде, не на действующей пользовательской попытке.
