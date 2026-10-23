# Ошибки подготовки местного сервера

Если фоновая подготовка местного сервера завершается ошибкой, `clientRuntime` сообщает
состояние `offline` с кодом `server_start_failed`. Текст причины передаётся отдельно
в `detail.message`; запасное сообщение берётся из каталога `desktop.serverNotPrepared`.
Запрос до создания транспорта получает HTTP 503 с тем же кодом в поле `error`.

`server_start_failed` — идентификатор протокола, его значение одинаково для всех языков.
В `web/scripts/i18n-scope.json` он указан как техническая строка только для
`desktop/src/clientRuntime.ts`. Собственные надписи по-прежнему проверяются по
[контракту языка интерфейса](interface-language.md).

Проверки: `npm --prefix web run check:ui`,
`tests/desktop/{client-startup,portable-runtime}.test.js`.
