# Медиа: runtime отдельно от исходников

`server/src/lib/media/` — локальный медиа-конвейер, а `lib/speech/SpeechRuntime` — единый
шов диктовки и видео. Python-venv принадлежит GrigDesk и обычно лежит в
`<папка данных>/state/media-venv`. `deploy/install.sh` идемпотентно создаёт его из
закреплённого `server/requirements-media.txt`; CUDA-вариант после явного выбора дополняет
`requirements-media-cuda.txt`. Установщик атомарно фиксирует абсолютные
`GRIGDESK_MEDIA_PYTHON` и `GRIGDESK_MEDIA_HF_DIR` в `.env` папки данных. Уже заданный собственный
Python не переписывает. Temp для `.env` создаётся с 0600 до записи секретов;
`--no-cuda`/`GRIGDESK_MEDIA_CUDA=0` удаляет `nvidia-cublas-cu12` и из старого venv.

Модели whisper живут **не в общем пользовательском кэше**, а в собственном
`GRIGDESK_MEDIA_HF_DIR` (`<папка данных>/state/hf` по умолчанию). Runtime очищает унаследованные
`HF_HUB_CACHE`/`HUGGINGFACE_HUB_CACHE`, закрепляет каталог и commit revision модели и
работает `local_files_only`: неполный snapshot означает «модель не готова», а не фоновую
загрузку из сети. Скачивание/копирование общего кэша — отдельные отменяемые model jobs в
«Настройки → Речь» с дисковым статусом. `doctor`/speech capabilities проверяют
ffmpeg/ffprobe/venv/faster-whisper, выбранную модель и реальный CUDA canary.

Наличие произвольного `blobs/*.incomplete` само по себе не означает, что pinned snapshot
сломан. `huggingface_hub==1.18.0` создаёт уникальный temp на попытку: отменённый worker
может оставить orphan, а повтор уже успешно положит финальный blob рядом. Готовность
подтверждают local-only resolution точной revision и реальные обязательные файлы snapshot
(включая цели symlink). Superseded temp игнорируется только когда соответствующий финальный
blob уже существует; отсутствующий обязательный файл или temp без финального blob по-прежнему
даёт `cached:false`.

Ручное создание нужно только при обходе установщика:
`python3 -m venv "${GRIGDESK_HOME:-$HOME/.grigdesk}/state/media-venv"`, затем
`"${GRIGDESK_HOME:-$HOME/.grigdesk}/state/media-venv/bin/python" -m pip install -r server/requirements-media.txt`; после этого
при штатной раскладке приложение подхватывает этот Python автоматически. Для
нестандартных каталогов нужно явно задать оба абсолютных пути в `.env`.
После переноса старые `bin/pip` и `activate` могут содержать прежний путь:
после удаления совместимых ссылок используйте `bin/python -m pip`.

До переноса fallback считался как `<каталог файла>/../.venv/bin/python`: исходный файл
лежал в `src/media/`, и `..` попадал в корень прежнего проекта, а в GrigDesk он стал
указывать на `server/src/lib/.venv`, которого не существует. Диктовка отвечала
`spawn .../lib/.venv/bin/python ENOENT` — путь выглядел настоящим, и искали не там.

Источник до переноса: docs/grigdesk/gotchas.md § Медиа: runtime отдельно от исходников
