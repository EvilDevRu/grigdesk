# Browser speech: onend не означает «включить снова»

Web Speech может закончить сессию после паузы. Перезапуск разрешает только FSM чата при
актуальных `desiredActive`, generation и revision настроек: без них поздний `onend` после
Stop, Esc, смены вкладки или смены движка снова включает микрофон. Терминальные ошибки
permission/audio/language не повторяются; `network` и `no-speech` имеют ограниченный
retry с backoff. Промежуточный текст живёт отдельным хвостом и заменяет себя, финальный
добавляется в поле ровно один раз — иначе recognizer затирает ручную правку пользователя.

`browserProcessing=auto` не означает «локально»: конкретный user agent может отправлять
звук своему сервису, поэтому первый `start()` требует явного consent, а каждый start/retry
заново валидирует на сервере его актуальную opaque revision и fail-closed обрывается offline.
`browserProcessing=local` проверяет `SpeechRecognition.available()` и устанавливает пакет
только по явному действию; отсутствие API — «не поддерживается», а не разрешение тихо
перейти в auto. Оба браузерных варианта, MediaRecorder и AudioWorklet требуют secure context.

Источник до переноса: docs/cockpit/gotchas.md § Browser speech: onend не означает «включить снова»
