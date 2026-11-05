# Вложения (фото) и диктовка

- **Вложения:** кнопка-скрепка, drag&drop на весь чат (оверлей «Отпусти, чтобы приложить»;
  dragenter/leave через счётчик — leave стреляет на каждом дочернем узле) или вставка
  картинки из буфера → сразу `POST /api/chat/upload`
  (multipart) → файл в `chats/attachments/<ts>-<имя>` (гитигнорится вместе с chats/). К сообщению
  клиент прикладывает `attachments: [{file, name}]`; сервер строит пути ТОЛЬКО внутри attachments/
  (защита от traversal/произвольного `--add-dir`), добавляет `--add-dir chats/attachments` и блок
  `[Вложения]` со списком путей — агент смотрит их инструментом Read (vision работает в plan-mode).
  Сообщение без текста, но с вложением — валидно. Превью в истории — `GET /api/chat/attachment/:file`.
  Пока агент работает, картинка у Codex и Claude уходит в текущий ход, а не в очередь —
  [картинки в уточнении](in-turn-images.md).
- **Неотправленные вложения — часть черновика чата**, а не состояние композера: `ChatsView`
  пересоздаёт `ChatSession` при каждом переключении (`:key`), и локальный список пропадал.
  Они лежат в поле чата `draftAttachments` (`{file, name, url, mime}`, без абсолютного
  `path` из ответа загрузки) и сохраняются тем же дешёвым путём, что текст черновика:
  переживают переключение, F5 и видны второму окну. Пустой список в запись чата не попадает.
  Загрузка запоминает чат на старте: ответ, пришедший после ухода в другой чат, дописывается
  туда, где файл приложили. Чат с одними вложениями список показывает как черновик, а
  закрытие такой вкладки уносит её в архив. Проверка: `tests/web/chat-draft-attachments*.test.js`.
- **Диктовка:** движок, язык, качество и словарь — серверные настройки во вкладке «Речь»;
  изменения приезжают всем окнам через SSE. Дефолтный browser-auto показывает промежуточный
  текст во время речи, но до первого `SpeechRecognition.start()` требует явного согласия:
  браузер может обрабатывать звук удалённо. Перед каждым start/retry вкладка повторно
  подтверждает серверу актуальную opaque revision; offline/stale ответ закрывает запуск.
  Browser-local запускается только после
  capability-check/явной установки языкового пакета и никогда не откатывается в auto молча.
  Если Web Speech недоступен, UI один раз объясняет переход на локальный Whisper.
- **Один controller на окно:** authenticated composition root в `App.vue` создаёт один
  `SpeechProvider`; полный `ChatSession` и карточка ответа на вопрос триажа в `TaskModal`
  по очереди получают у него lease. Контроллер не копируется в компоненты и уничтожается
  при logout. Terminal `onFinal` только дописывает текст через `onCommit`. Захват нового
  lease, unmount, logout и смена exact chat инвалидируют generation, поэтому поздний callback
  прежней диктовки не может попасть в другой разговор.
- **Озвучки нет:** браузерный `speechSynthesis` и серверный вердикт `speechSafe` ушли вместе с
  компактным компаньоном (2026-09-10). Ответы агента только показываются; диктовка (STT)
  осталась в полном чате и `TaskModal`.
- **Локальный live-путь:** `AudioWorklet` переводит вход в PCM16 mono 16 кГц и посылает его
  в авторизованный same-origin WebSocket `GET /api/chat/transcribe/stream`. Стартовый кадр
  фиксирует protocol v1, `sessionId`, актуальную server-owned `revision` и точный контракт
  `{encoding:"pcm_s16le",sampleRate:16000,channels:1,frameSamples:1600}`; бинарные кадры
  идут с монотонным `uint32 LE seq`, сервер отвечает `ack` и не принимает пропуски или
  повторы. Origin обязан быть буквальной canonical-формой origin запроса без path/query/
  credentials; стартовый JSON должен прийти за 10 с после upgrade. На одну диктовку
  поднимается один non-detached worker с pinned
  `local_files_only` моделью faster-whisper: он запускает один decode после каждых 2 с
  нового звука, использует overlap 1,5 с и rolling window до 30 с, а LocalAgreement
  закрепляет только общий префикс соседних гипотез. Накопившиеся промежуточные запросы
  схлопываются до последнего watermark. Два последовательных пустых/VAD-окна безопасно
  продвигают старую тишину, сохраняя overlap перед возможной поздней речью. Это
  псевдостриминг Whisper, не stateful streaming encoder, поэтому фактическую задержку
  нельзя обещать без замера.
- **Текст и завершение:** cumulative partial показывается только отдельной строкой
  «Слышу…» непосредственно над композером: растущий partial не сдвигает поле ввода и не
  трогает его текст. После успешного непустого `done` итог
  дописывается в textarea ровно один раз и сам не отправляется. Stop делает ограниченный
  по времени drain с tail flush, Esc отменяет незакреплённый результат; до live-`done`
  либо завершения batch fallback отправка и slash-команды заблокированы, само поле
  остаётся редактируемым. Кнопка во время записи становится Stop: вокруг неё пульсирует
  красная подложка; отдельного нижнего индикатора уровня нет, `prefers-reduced-motion`
  отключает анимацию.
- **Аварийное завершение:** полный `MediaRecorder` WebM/Opus пишется параллельно. Если
  AudioWorklet/WebSocket/worker не стартовал, оборвался, не успел завершить drain или
  вернул пустой final, Stop отправляет этот целый файл в прежний
  `POST /api/chat/transcribe`; WebM не режется на независимые timeslice-контейнеры.
  Только preflight без WebSocket, AudioContext или AudioWorklet запускает batch warmup;
  после фактической live-попытки fallback остаётся one-shot. Multipart передаёт тот же
  `streamSessionId`, поэтому runtime отменяет и ждёт child `close` именно этой live-сессии
  до запуска batch, даже если WebSocket-close ещё не обработан; уже начатые отмены тоже
  дожидаются, чужие активные диктовки — нет. Если bounded TERM/KILL не подтвердил `close`,
  slot и workDir остаются в quarantine до настоящего exit. One-shot без correlation
  тоже не запускает вторую модель при таком quarantine, а fail-closed отвечает
  `503 speech_stream_busy`.
  Если `MediaRecorder.onstop` не приходит, watchdog через 2 с продолжает завершение с
  уже собранным WebM.
  Падение локального stream никогда не включает `browser:auto`: потенциально удалённая
  обработка остаётся только явным выбором человека с consent.
- Выбранная Whisper-модель должна быть заранее скачана model job-ом; скрытой сетевой
  загрузки из распознавания нет. CPU/int8 остаётся переносимым путём, в том числе на
  машине с AMD GPU; ускорение CUDA опционально и относится только к NVIDIA, ROCm-пути
  в текущем runtime нет. `maxStreams=2` считает pending/active/cancelling/quarantined
  live-сессии; decode pending, rolling window и Stop/drain ограничены 30 с, server
  live PCM — 5 минутами. После worker `ready` transport idle равен 30 с, hard wall-clock
  session — 6 минутам; тихие PCM-кадры сбрасывают idle timer. Пять минут — не auto-stop:
  полный `MediaRecorder` продолжает recovery-запись до ручного Stop. Клиент ждёт ready
  до 45 с и держит не более 768 КиБ PCM (примерно 24 с, меньше серверных 30 с); это
  защитные отсечки, не latency SLA. Клик Stop сразу запускает единый live-stop, не ждёт
  `MediaRecorder.onstop`; поздний callback переиспользует тот же promise. Cancel во время
  Stop/finishing не выпускает поздние `final`/`done`. Stop, Esc и unmount инвалидируют
  generation и чистят WebSocket, worker, AudioWorklet/AudioContext,
  MediaRecorder и MediaStream; ожидания best-effort close AudioContext и socket
  ограничены 750 мс каждое, поздние события старой сессии не могут дописать текст.
  **Грабля:** getUserMedia требует secure context — по `http://<адрес в локальной сети>`
  микрофон недоступен; работает на localhost или через HTTPS.
