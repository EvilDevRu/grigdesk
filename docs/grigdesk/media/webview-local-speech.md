# Локальное распознавание в Android WebView

Наличие `SpeechRecognition.available` и `processLocally` не доказывает, что встроенный
Android WebView обслуживает локальное распознавание. Наблюдавшийся WebView объявлял оба
API, но первый вызов `available({ processLocally: true })` завершал renderer: журнал
Chromium сообщал `No binder found for interface media.mojom.OnDeviceSpeechRecognition`,
затем `Terminating renderer for bad IPC message, reason 123`. Это native-отказ;
JavaScript `try/catch` не успевает его перехватить.

`browserLocalSpeechAllowed` исключает этот вызов для стандартного Android WebView по
маркеру `wv` в User-Agent. Маркер сохраняется и после сокращения User-Agent; контракт
описан в [документации Android](https://android-developers.googleblog.com/2024/12/user-agent-reduction-on-android-webview.html).
Полный клиент сохраняет стандартный User-Agent. Проверка совместимости не является
проверкой доступа и не использует модель телефона или конкретную версию Chromium.

Одна проверка применяется в настройках речи и перед запуском браузерного режима local.
Настройки показывают локальную браузерную модель недоступной; контроллер использует
существующий переход к Whisper либо сообщает неподготовленность сервера. Сохранённый
режим local не меняется, облачный режим auto и согласие не включаются. Обычный Chrome
Android без маркера WebView сохраняет прежнюю проверку возможностей и выбранного языка.

Регрессии в `speech-browser-support.test.js` проверяют отсутствие опасного вызова,
реальное открытие SpeechPage без записи настроек, запуск local и отдельный Chrome Android.
Тест не имитирует native crash: подтверждение причины и результата требует повторного
перехода на физическом Android и журнала Chromium.
