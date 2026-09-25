# Live Whisper — rolling decode, а не WebM-чанки и не настоящий streaming encoder

Локальная диктовка передаёт звук через авторизованный same-origin WebSocket
`/api/chat/transcribe/stream`: `AudioWorklet` ресемплирует вход в PCM16 mono 16 кГц,
стартовый JSON фиксирует protocol v1, `sessionId`, актуальную revision настроек и точный
аудиоконтракт `{encoding:"pcm_s16le",sampleRate:16000,channels:1,frameSamples:1600}`;
бинарные кадры начинаются с `uint32 LE seq`, а сервер подтверждает их `ack`. Upgrade
принимает только действующую сессию и буквальный canonical Origin
`scheme://host[:port]`, равный origin запроса: path, query, credentials и альтернативная
запись стандартного порта не допускаются. Поэтому сравнивать только `URL.origin` без
равенства исходной строки нельзя.
У Vite dev-proxy для `/api` нужны `ws: true` и `rewriteWsOrigin: true`: иначе браузер
честно присылает Origin `:5180`, backend сравнивает его со своим `:8140` и отклоняет
легитимный dev-upgrade. В production оба адреса уже одного origin.
После upgrade клиент обязан прислать стартовый JSON за 10 с: иначе ещё не начавшее
распознавание закрывается по timeout и не удерживает WebSocket без границы.
При backpressure аудио не выбрасывается: в один момент работает один decode, а лишние
запросы схлопываются до последнего watermark.

Дефолтные предохранители сейчас конкретны: `maxStreams=2` считает pending, active,
cancelling и quarantined sessions; decode interval 2 с,
overlap 1,5 с, rolling window 30 с, непродекодированный pending 30 с, принятый live PCM
5 минут и Stop/drain 30 с. После worker `ready` отсутствие новых PCM-кадров 30 с считается
transport idle, а hard wall-clock всей session ограничен 6 минутами. Тихие PCM-кадры
тоже сбрасывают idle timer. Пять минут — server PCM limit, а не auto-stop UI:
`MediaRecorder` продолжает писать recovery blob до ручного Stop. Клиент ждёт server
`ready` до 45 с и ограничивает свою очередь PCM 768 КиБ — примерно 24 с PCM16/16 кГц
mono и намеренно меньше серверных 30 с. Эти числа ограничивают ресурсы и время аварийного
ожидания, но ничего не обещают о time-to-first-partial или final latency.

Нельзя подменять этот путь `MediaRecorder.start(timeslice)` и распознавать каждый WebM/Opus
кусок отдельно. Поздний кусок не обязан иметь самостоятельный container header, а граница
режет слова. Поэтому полный MediaRecorder WebM пишется **параллельно и целиком** только для
аварийного `POST /api/chat/transcribe`, а live-канал получает сырой PCM.

На диктовку живёт отдельный non-detached worker с уже разрешённой pinned revision модели
и `local_files_only=True`; между диктовками он не остаётся. faster-whisper не хранит
stateful encoder cache: worker повторно декодирует rolling-окна с overlap, LocalAgreement
закрепляет общий префикс двух последовательных гипотез, а изменяемый хвост остаётся
partial. Поэтому это псевдостриминг и его latency зависит от RTF машины — цифры появляются
только после живого замера, а не из размера окна в коде. Глобальный resident daemon этапа
4b для этой схемы не нужен и по-прежнему отложен.

Partial живёт только в строке «Слышу…»: писать его в textarea нельзя, иначе следующая
гипотеза затрёт ручную правку. После непустого `done` final дописывается туда ровно один
раз. Stop закрывает вход и делает bounded drain с tail flush; Esc отменяет сессию. Если
live-путь не поднялся, оборвался, не уложился в drain **или завершился пустым final**, Stop
распознаёт сохранённый полный WebM старым batch endpoint. Только preflight-отказ из-за
отсутствия WebSocket, AudioContext или AudioWorklet запускает batch warmup: после
фактической live-попытки fallback идёт one-shot, чтобы не поднимать рядом вторую модель.
Multipart fallback несёт тот же `streamSessionId`: перед batch runtime сам отменяет
именно соответствующую live-сессию и ждёт подтверждённый child `close`, даже если обработчик
закрытия WebSocket ещё не успел начать cleanup. Затем он ждёт уже начатые отмены других
stream workers, но не сериализуется с чужими активными диктовками. Если bounded
stdin EOF → TERM → KILL не дал `close`, ошибка остаётся fail-closed, а slot и workDir
переходят в quarantine до фактического process exit; объявлять PID мёртвым по одному
истёкшему таймеру нельзя. One-shot без correlation при таком quarantine тоже отвечает
`503 speech_stream_busy` и не запускает вторую модель. Авария никогда не включает
`browser:auto`: это могло бы
незаметно отправить голос удалённому сервису без нового явного выбора и consent.

Cleanup тоже обязан быть ограниченным и best-effort. Клик Stop сразу запускает единый
live-stop, не дожидаясь `MediaRecorder.onstop`; поздний recorder callback переиспользует
тот же promise. Tail flush AudioWorklet ждётся до 500 мс, ожидание закрытия
`AudioContext` и WebSocket — до 750 мс каждое, а конкурентные Stop/cancel ждут общий
cleanup barrier. Если `MediaRecorder.onstop` не приходит, watchdog через 2 с продолжает
завершение с уже собранным WebM. Эти отсечки не означают, что модель распознала речь
за то же время. Cancel во время Stop/finishing остаётся отменой: поздний decode после
cleanup barrier не может «воскресить» сессию событием `final`/`done`.

Переносимость здесь означает CPU/int8 CTranslate2: он работает независимо от марки GPU,
поэтому машина с AMD-картой не остаётся без диктовки. Текущий ускоренный backend — только
CUDA/NVIDIA; наличие AMD GPU само по себе ускорения не даёт, ROCm не установлен и не
обещан. На CPU real-time тоже не обещан: если decode медленнее входящего звука, отставание
растёт, после чего bounded drain либо завершит хвост, либо включится batch fallback.

Во время записи сама кнопка микрофона становится Stop и получает красную пульсирующую
подложку; отдельный нижний meter удалён. Анимация — только сигнал состояния, не измеритель
громкости, и отключается через `prefers-reduced-motion`.

Whisper на тишине способен галлюцинировать готовые фразы, поэтому VAD остаётся включён.
При длинной тишине rolling watermark продвигается только после двух последовательных
пустых/VAD-гипотез и сохраняет overlap 1,5 с: иначе 30-секундное окно ложно сработало бы
как backpressure либо pruning мог бы отрезать начало поздней речи.
`hallucination_silence_threshold` сам по себе не помогает без `word_timestamps=True`, а
проектные термины передаются как `hotwords`, не как `initial_prompt`. CUDA capability —
это короткий реальный canary с тем же env, что транскрипция: один импорт не обнаруживает
отсутствующий `libcublas.so.12`, потому что ошибка возникает лишь на первом инференсе.
Вариант CUDA устанавливается воспроизводимо командой `deploy/install.sh --with-cuda`.

Источник до переноса: docs/cockpit/gotchas.md § Live Whisper — rolling decode, а не WebM-чанки и не настоящий streaming encoder
