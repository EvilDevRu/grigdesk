# Пакет кастомного драйвера в протокольных проверках

После извлечения `b24-custom` протокольные барьеры ядра импортируют настоящий пакет
из отдельного репозитория. В `server/src` копии сессионного клиента нет.
Подготовка пакета — входное условие этих проверок, а не действие теста.

`tests/server/helpers/trackerCustomPackage.js` использует `GRIGDESK_CUSTOM_DRIVER_DIR`.
Без переменной он ожидает `grigdesk-desk-drivers/b24-custom` рядом с checkout GrigDesk.
Если пакет подготовлен в другом разрешённом каталоге, путь нужно явно передать
в окружение команды проверки. Значение указывает на корень с `driver.json`,
`driver.ts` и `src/`, а не на установленную папку данных пользователя.

```sh
export GRIGDESK_CUSTOM_DRIVER_DIR="$driver_source"
bash "$task_test_wrapper" "$task_number" \
  tests/server/b24-dashboard.test.js tests/server/b24-groups.test.js \
  tests/server/b24-task-presence.test.js tests/server/b24-task-update.test.js \
  tests/server/task-favorites-api.test.js tests/server/tracker-custom-protocol.test.js \
  tests/server/tracker-legacy-barrier.test.js
```

Здесь `driver_source`, `task_number` и путь профильной обёртки `task_test_wrapper`
задаёт окружение задачи. Тот же путь пакета нужен
при повторном прогоне этих файлов проверяющим узлом. Сторож памяти сохраняет эту
переменную; фикстуры копируют пакет в собственный временный `dataDir`.

Отсутствие пакета даёт `ERR_MODULE_NOT_FOUND` при импорте клиента либо `ENOENT`
при копировании, до проверки протокола. Такой отказ не доказывает регрессию клиента.
Подмена клиента копией в ядре или пропуск барьера нарушили бы границу извлечения.
Успех проверки с явным путём также не означает доставку пакета в конечный репозиторий
или его установку на сервер: это отдельные действия поставки.
