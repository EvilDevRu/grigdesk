# Ядро озвучки voice: облако Qwen и локальные движки

`utilities/voice/` — Go-утилита одноразового синтеза речи. `bin/utilities/voice` —
его нативный бинарник для Linux x64 и Apple Silicon. Каталог `bin/utilities/` входит в PATH агента, поэтому
агент вызывает `voice`, человек из checkout — `bin/utilities/voice` либо `grigdesk-ctl voice`.
Команда не требует перезапуска сервера и не читает его файловые хранилища ключей.

## Команды и результат

```sh
voice engines --json
voice models --json
voice voices --engine qwen --json
voice engines --service qwencloud-token --json
voice voices --service qwencloud-token --engine qwen --json
voice install piper
voice install silero --json
voice generate --engine piper --text "Проверка связи" --out speech.wav
voice generate --engine silero --voice xenia --text "з+амок и зам+ок" --pace slow
voice generate --engine qwen --file narration.txt --out narration.wav
voice generate --service qwencloud-token --text "Я плач+у за билет" --out speech.wav
voice version
voice help
```

`--text` и `--file` взаимоисключающие; файл читается как строгий UTF-8. Без `--out`
создаётся `./voice-<UTC-метка>-<UUID>.wav`, независимые команды сохраняют разные файлы.
Успешный `generate` печатает одну JSON-строку с `engine`, `model`, `service`, `voice`,
`file`, `bytes`, `format`, `ignoredDirections`, `warnings`. У локальных движков `service=null`.
Прогресс установки и ошибки идут в stderr. Остальные
команды поддерживают `--json`. Коды выхода: 0 — успех, 2 — аргументы, 1 — выполнение.
Неизвестный голос — код 2 без замены другим голосом.

V1 выдаёт только WAV. `--format mp3` отклоняется до сети и процессов; конвертации нет.
Производитель пишет в приватный соседний временный каталог, проверяет RIFF/WAVE,
fmt/data и размер до 64 МиБ, затем делает rename в конечный путь. Ошибка или отмена
сохраняет прежний файл и убирает собственный временный каталог.

## Конфигурация и автовыбор

Сервис выбирается явно: `--service` → `GRIGDESK_VOICE_QWEN_SERVICE` → `model-studio`.
Допустимы `model-studio` и `qwencloud-token`. У обоих облачных профилей engine ID — `qwen`;
выбор сервиса меняет адаптер, модель, каталог голосов и контракт запроса.
Сервис исполнителя чата автоматически не наследуется, файловые настройки не читаются.

Ключ Qwen берётся из первого непустого явного источника:

1. `--api-key`;
2. `GRIGDESK_VOICE_QWEN_API_KEY`;
3. `TOKEN_PLAN_API_KEY` — только для `qwencloud-token`;
4. `DASHSCOPE_API_KEY`.

Флаг `--api-key` виден в списке процессов; надёжнее окружение. Ключ не печатается,
из ожидаемых ошибок удаляется целиком; сырые транспортные ошибки не выводятся.
Файловые хранилища доступов сервера не читаются. Наследуемый `DASHSCOPE_API_KEY` —
законный источник, в том числе у агента, чей процесс получил env исполнителя Qwen
от сервера. Поэтому отсутствие явного флага не означает отсутствие облачного ключа.

Источник ключа не подтверждает совместимость тарифа. `model-studio` блокирует ключ
`sk-sp-…` до сети и предлагает явный выбор сервиса. Префикс бывает у разных подписок,
поэтому сервис по нему не угадывается. `qwencloud-token` проверяет наличие подписочного
ключа, но его действительность и доступ к TTS подтверждает только живой запрос.
После отказа ключ не отправляется другому сервису или региону.
[Проверенный подписочный API и эксперимент](voice-qwen-token-plan.md).

Без `--engine` выбирается первый готовый движок: **Qwen → Piper → Silero**. При ключе
текст уйдёт в платное облако. Для локального синтеза указывайте `--engine piper` или
`--engine silero`. После отказа выбранного движка автоматического fallback нет.
`engines` показывает готовность, причину и способ восстановления; doctor облака
проверяет наличие ключа, действительность ключа подтверждает только живой запрос.

Каталог данных: `--dir` → `GRIGDESK_VOICE_DIR` → `~/.grigdesk/voice`.
Базовый адрес Qwen переопределяется через `GRIGDESK_VOICE_QWEN_BASE_URL`;
по умолчанию `https://dashscope-intl.aliyuncs.com` для Model Studio или
`https://token-plan.maas.qwencloudapi.com` для QwenCloud Token Plan.
Допустим HTTP(S) без credentials, query и fragment. Смена только адреса не меняет адаптер.

## Движки и возможности

| Движок | Модель / default голос | Лимит канонического текста | Темп | Ударения |
| --- | --- | --- | --- | --- |
| Qwen, Model Studio | `qwen3-tts-flash` / `Cherry` | 600 | не применяется | не применяются |
| QwenCloud Token Plan | `qwen-audio-3.0-tts-plus` / `longanhuan_v3.6` | 2000 | пять ступеней | экспериментальные `+` и U+0301 |
| Piper, локально | `irina` / `irina` | 2000 | пять ступеней | не применяются |
| Silero, локально | `v5_5_ru` / `xenia` | 2000 | пять ступеней | `+` перед гласной |

Каталог Model Studio содержит 48 голосов с русским. Token Plan использует свой
[каталог голосов и языков](voice-qwen-token-plan.md#каталог-голосов-и-языков) для
`qwen-audio-3.0-tts-plus`. `--language` передаёт код языка адаптеру. Model Studio
использует Auto по умолчанию. Token Plan учитывает текст и список языков диктора
(`ru`, `en` или `zh`) и проверяет явно заданный язык до HTTP. Паузы, tone и emphasis в v1
не заявлены. Общий парсер снимает `+` из канонического текста; Silero восстанавливает
метки в нужных позициях и передаёт темп скрипту через `--rate`. Обёртку SSML строит
сам Python-скрипт. Piper получает канонический текст и `--length-scale`.

`--pace`: `slowest|slow|normal|fast|fastest`. Неприменённые ударения, отличный от normal
темп без поддержки и непустой `--instruction` перечисляются в `ignoredDirections`.
`--instruction` применяется только в Token Plan. Его адаптер переводит `+` в U+0301
после гласной, сохраняет уже введённые Unicode-метки и дополняет инструкцию подсказкой.
Общий предел инструкции с подсказкой — 1600 символов, без тихого обрезания текста.
Передача ударений помечена `stressMode=experimental`; при метках результат содержит
предупреждение в `warnings`, а не обещание правильного произношения. Каждую важную
реплику нужно прослушать. Silero отклоняет латиницу и цифры
до запуска Python со списком обрывков: их нужно записать русскими словами.

Model Studio использует нестриминговый POST
`/api/v1/services/aigc/multimodal-generation/generation` с Bearer и телом
`{model, input:{text, voice, language_type}}`. Format/sample_rate/instruction не
передаются. `output.audio.url` скачивается сразу отдельным GET без Authorization;
срок ссылки поставщика — 24 часа. Общий deadline POST/JSON/GET/body — 120 секунд;
платный POST не повторяется. HTTP-ошибка сообщает статус без тела ответа и ключа.
Источники контракта: [профильный API Model Studio](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen-tts-api),
[каталог голосов](https://www.alibabacloud.com/help/en/model-studio/qwen-tts-voice-list).

Token Plan использует `POST /api/v1/services/audio/tts/SpeechSynthesizer` с моделью
`qwen-audio-3.0-tts-plus` и `input:{text,voice,format,sample_rate,language_hints,rate,instruction}`.
Формат — WAV mono PCM16 24 кГц. Общий транспорт `qwenTransport.ts` сохраняет один
deadline, запрет повторного POST и скачивание без ключа. `qwenTokenWav.ts` исправляет
только наблюдавшуюся пару потоковых размеров RIFF/data в ожидаемом PCM-заголовке,
после чего применяется обычная строгая проверка WAV. Отсчёты не перекодируются;
ffmpeg или Python для облачного профиля не нужны. Произвольные обрезанные WAV отклоняются.

## Установка и хранение локальных движков

Нужны Python3 с venv, tar для Piper, сеть и свободное место. Каталог пакетов,
контрольные суммы и зависимости принадлежат `utilities/voice/internal/local/packages.json`; Python-ассеты
также принадлежат пакету voice. Серверные потребители вызывают CLI и не хранят копий
каталога или установщиков. Runtime-импортов серверного showcase нет.

| Пакет | Загрузка | SHA256 загрузки | Зависимости |
| --- | --- | --- | --- |
| Piper irina | 58 340 190 байт | `897b62f170faee38f21d0bc36411164166ae351977e898b6cf33f6206890b55f` | `piper-tts==1.8.0`, `onnxruntime==1.23.2` |
| Silero v5.5 ru | 145 420 684 байт | `50081637b602126ee06cb3bc8a744d25651d2da149ee8864b9a379bfdd934437` | `torch==2.13.0+cpu` из CPU index |

Piper дополнительно сверяет SHA модели и config. Silero требует также примерно
200 МБ для движка; место под распакованный runtime/wheels нужно сверх модели.
Каталог указывает GPLv2 для голоса Piper (корпус RHVoice) и CC BY-NC-SA 4.0 для
Silero: некоммерческое использование. Учитывайте лицензии при использовании результата.

Кэш загрузки — `cache/piper-irina.tar.gz` / `cache/silero-v5_5_ru.pt`. Обрыв оставляет
принятый префикс; повтор использует Range. Неверный Content-Range не меняет префикс;
416 или битый полный кэш допускают один сброс. Размер и SHA проверяются до создания
каталога движка. Корректный архив не доказывает готовность Python.

Общий `cache/install.lock` использует PID/starttime/token через shared directoryLock.
Живой или неизвестный владелец блокирует установку, чужой lock не снимается. После
доказанной смерти владельца общий механизм перехватывает блокировку и повторяет захват.
Штатная отмена ждёт close своего child, затем освобождает только собственный lock.

Runtime создаётся сразу по постоянному пути `engines/<id>/runtimes/<uuid>`;
`.voice-runtime.json` фиксирует fingerprint requirements/index. Повторное использование
требует marker и успешной проверки импортов/версий. `engines/<id>/venv` — атомарно
переключаемая ссылка на принятую generation. Обычный каталог вместо этой управляемой
ссылки автоматически не удаляется и даёт отказ.

Приёмка вызывает raw-синтез с явными model/config из staging и фразой «проверка связи».
Требуются корректный непустой WAV и конечный peak ≥ 0.005: «установлено = говорит».
Лишь затем публикуются файлы, `voice.json` и ссылка venv. Piper хранит модель в
`engines/piper/voices/irina/`, Silero — в `engines/silero/models/v5_5_ru/`.
Этой раскладкой владеет voice; «Презентации» используют её через CLI без переноса файлов.

Общий install — 30 минут, загрузка — 15 минут, venv — 60 секунд, pip — 20 минут,
import — 15 секунд Piper / 90 секунд Silero, tar — 120 секунд, синтез/приёмка — 300 секунд.
SIGINT/SIGTERM отменяют собственную операцию. SIGKILL не выполняет finally: кандидат
остаётся отдельной неопубликованной generation; следующий запуск создаёт новый UUID.
Чужие или прежние orphan runtime автоматически не удаляются.

## Сборка и границы проверки

`voice` собирается вместе с остальными утилитами командой
`bash tools/build-go-utilities.sh "$PWD/bin/utilities"` на Go 1.27.4. В бинарник
встроены Python-скрипты Piper и Silero. Синтез извлекает нужный скрипт в закрытый
временный каталог. Серверный архив включает `bin/voice` с правами 0555 в подписанной
описи. Команда доступна агентам текущего серверного поколения.

Автоматические проверки используют loopback HTTP и поддельный executable Python;
installer, tar, WAV, checksum, блокировки и файловая публикация остаются настоящими.
Они проверяют опубликованный контракт, но не звук внешнего сервиса или реальной модели.
Живое произношение требует ручной проверки. Настоящие `voice install piper` /
`voice install silero` при реализации не выполнялись. Результаты живых опытов Token Plan
и частичной ручной проверки ударений описаны в [профиле Token Plan](voice-qwen-token-plan.md).
Историческая
portable-приёмка запускается только с отдельно предоставленным готовым комплектом.

Отложены локальный Qwen3-TTS на GPU, Edge, Yandex, RHVoice, `voice serve`/батчи и ASR.

## Потребитель: Презентации

`server/src/lib/showcase/voice/packageEngine.ts` — адаптер CLI с четырьмя независимыми
сервисами `qwen-studio`, `qwen-token`, `piper`, `silero`. Он читает JSON команд
`engines`, `models`, `voices`, проверяет готовность через doctor и делает один generate
на запрос. Облачный POST не повторяется. Ключи передаются только окружением child:
DASHSCOPE_API_KEY для Model Studio, TOKEN_PLAN_API_KEY для Token Plan.

`packageInstall.ts` — тонкая кнопка `voice install` с сохранённой попыткой, сериализацией
start/cancel/recover и ожиданием close перед повтором. Установка моделей, их лицензии
и раскладка принадлежат voice. Холодные synthesize/preview и восстановленная сборка
сами проверяют готовность, без предварительного открытия каталога интерфейсом.
Ссылки прежних неизвестных движков отклоняются без подмены.

Контракт проверен через настоящие поддельные executable, WAV и файловую публикацию.
Эти проверки не подтверждают реальную установку Piper/Silero и облачный звук.
Пользовательский поток описан в [Презентациях](../guide/ru/showcase.md).
