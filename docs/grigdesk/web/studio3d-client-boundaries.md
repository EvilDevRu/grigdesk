# Границы клиента 3D

`pendingIntentTypes.ts` задаёт три вида сохранённого нажатия. Run хранит полный
StudioRunRequest; retry требует modelId/versionId и ожидаемую цену; batch — полный
серверный snapshot с snapshotHash. Общие поля JSON, UUID, owner, libraryId, fingerprint
и время первого нажатия сохраняются. `pendingIntents.ts` реэкспортирует прежние типы,
владеет IndexedDB и подтверждает запись только transaction complete.

`pendingIntentController.ts` содержит отправку, coalescing, снятие и восстановление
намерений. Узкие порты дают storage, четыре метода API, канонический fingerprint,
часы/UUID, текущую сессию, raw pending и callbacks для busy, ошибок, обновлений и тостов.
В нём нет Vue, SSE, собственного owner или второго хранилища проекций.

`stores/studio3d.ts` создаёт один контроллер внутри экземпляра Pinia. Store сохраняет refs,
SSE, поколения, таймеры, чтения моделей и задач. Порт pending.list возвращает toRaw;
onSent использует прежние loadModels/loadTasks/openModel. Stop меняет поколение и сессию,
но не очищает sending и не отменяет уже отправленный платный POST.

До POST сохраняется JSON-копия запроса с libraryId и UUID. Отпечаток считается по owner,
kind, modelId/versionId и request без idempotencyKey. Потерянный ответ сохраняет прежние
UUID, тело и at; blocked запись не подбирается для нового решения. Recovery сначала
читает server job: только 404 разрешает повтор исходного снимка до десяти минут
включительно. Старшее нажатие и доказанный 4xx снимаются с прежним объяснением.

Снятие записи после ответа POST и запись blocked при 4xx выполняются независимо от
поколения. Price_changed возвращает новый расчёт без второго POST. Обновления UI требуют
исходное поколение и library marker ответа; ошибка и окончание busy — исходное поколение.
После put отдельно проверяются поколение, owner и started, до добавления pending и POST.

Типовые примеры проверяет штатный web typecheck. Отдельные Node-тесты контроллера используют
один класс Studio3dApiError и управляемые порты; тесты Pinia проверяют настоящее подключение
с сохранёнными подменами внешнего транспорта и storage.
