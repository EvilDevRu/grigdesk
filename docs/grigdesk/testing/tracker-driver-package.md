# Внешние пакеты драйверов в проверках

После извлечения `grigdesk-b24-discript` протокольные барьеры ядра импортируют настоящий пакет
из отдельного репозитория. В `server/src` копии сессионного клиента нет.
Подготовка пакета — условие выполнения зависимых проверок, а не действие теста.

Имена пакетов владельца: `grigdesk-b24` — стоковый REST, `grigdesk-b24-discript` — кастомный портал.
В `driver.json` и `package.json` обоих пакетов указана версия `0.1.0`.

`tests/server/helpers/trackerPackage.js` использует `GRIGDESK_CUSTOM_DRIVER_DIR`.
Без переменной он ожидает `grigdesk-desk-drivers/grigdesk-b24-discript` рядом с checkout GrigDesk.
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

Без явного пути отсутствие соседнего каталога даёт skip зависимого теста с причиной
«пакет не подготовлен: …». При непустом явном env отсутствие пакета остаётся ошибкой.
Существующий повреждённый пакет тоже не пропускается; подробности —
[правила skip](tracker-package-skips.md). Для приёмки нужны оба пакета и ноль пропусков.
Подмена клиента копией в ядре нарушила бы границу извлечения.
Успех проверки с явным путём также не означает доставку пакета в конечный репозиторий
или его установку на сервер: это отдельные действия поставки.

Стоковые проверки используют тот же helper: `GRIGDESK_STOCK_DRIVER_DIR` либо соседний
`grigdesk-desk-drivers/grigdesk-b24`. Фикстуры явно копируют stock в свой `driversDir`;
наличие stock в каждом каталоге ядро больше не гарантирует. Собственные тесты stock
импортируют его точку входа и работают без runtime-импортов ядра.
