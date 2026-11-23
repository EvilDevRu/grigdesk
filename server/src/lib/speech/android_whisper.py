"""Распознавание на CPU пробного Android APK и подготовка проверенных моделей GGML."""

import ctypes as c
import hashlib
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
from types import SimpleNamespace
import urllib.request


CATALOG = json.loads(Path(__file__).with_name('android-models.json').read_text())
LIBRARY = os.environ.get('GRIGDESK_ANDROID_WHISPER_LIB')


def model_path(model_id):
    """Модели устройства хранятся отдельно от снапшотов CTranslate2."""
    if model_id not in CATALOG['files']:
        raise ValueError('Неизвестная модель речи')
    return Path(os.environ['HF_HOME'], 'ggml', CATALOG['revision'], model_id, 'model.bin')


def inspect_model(model_id):
    """Готовый файл появляется только после проверки хеша и загрузки движком."""
    weights = model_path(model_id)
    cached = weights.is_file() and weights.stat().st_size == CATALOG['files'][model_id]['size']
    return {
        'modelId': model_id,
        'cached': cached,
        'snapshotPath': str(weights.parent) if cached else None,
        'reason': None if cached else 'Модель GGML ещё не установлена',
    }


def install_model(model_id, progress=lambda *_: None):
    """Скачивает pinned файл во временный путь и публикует целую модель атомарно."""
    target = model_path(model_id)
    entry = CATALOG['files'][model_id]
    if inspect_model(model_id)['cached']:
        with target.open('rb') as existing:
            valid = hashlib.file_digest(existing, 'sha256').hexdigest() == entry['sha256']
        if valid:
            with Model(target):
                return

    target.parent.mkdir(parents=True, exist_ok=True)

    # Блокировки установки и model jobs исключают одновременную запись этих весов.
    temporary = target.with_suffix('.part')
    temporary.unlink(missing_ok=True)
    if shutil.disk_usage(target.parent).free < entry['size']:
        raise OSError('Недостаточно места для загрузки модели речи')

    url = f"https://huggingface.co/{CATALOG['repo']}/resolve/{CATALOG['revision']}/{entry['name']}"
    tls = ssl.create_default_context(cafile=os.environ['GRIGDESK_ANDROID_SPEECH_CA'])
    digest = hashlib.sha256()
    done = 0
    report_at = 0

    try:
        with urllib.request.urlopen(url, context=tls, timeout=45) as source, temporary.open('wb') as file:
            while chunk := source.read(1024 * 1024):
                done += len(chunk)
                if done > entry['size']:
                    raise RuntimeError('Размер модели GGML превышает ожидаемый')
                digest.update(chunk)
                file.write(chunk)
                if done >= report_at:
                    progress(done, entry['size'], entry['name'])
                    report_at = done + 8 * 1024 * 1024
            if done != entry['size'] or digest.hexdigest() != entry['sha256']:
                raise RuntimeError('Размер или контрольная сумма модели GGML не совпали')
            file.flush()
            os.fsync(file.fileno())
        with Model(temporary):
            pass
        temporary.replace(target)
        fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        progress(done, done, entry['name'])
    finally:
        temporary.unlink(missing_ok=True)


def decode_audio(recording):
    """Получает одинаковый PCM 16 кГц из записи WebView, файла или входного WAV."""
    args = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error']
    source = 'pipe:0' if isinstance(recording, bytes) else os.fspath(recording)
    result = subprocess.run(
        args + ['-i', source, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
        input=recording if isinstance(recording, bytes) else None,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors='replace').strip())
    return result.stdout


def check_engine():
    """Проверяет загрузчик и точку входа до скачивания весов."""
    return c.CDLL(LIBRARY).grigdesk_whisper_open


class Model:
    """Один native контекст на воркер, включая прогрев и повторные окна потока."""

    def __init__(self, weights):
        self.lib = c.CDLL(LIBRARY)
        self.open = self.bind('grigdesk_whisper_open', c.c_void_p, c.c_char_p)
        self.free = self.bind('whisper_free', None)
        self.decode = self.bind(
            'grigdesk_whisper_decode', c.c_int, c.c_void_p, c.c_void_p, c.c_int, c.c_char_p,
            c.c_int, c.c_int, c.c_char_p, c.c_bool, c.c_bool,
        )
        self.language_id = self.bind('whisper_full_lang_id', c.c_int)
        self.language_name = self.bind('whisper_lang_str', c.c_char_p, c.c_int)
        self.count = self.bind('whisper_full_n_segments', c.c_int)
        self.start = self.bind('whisper_full_get_segment_t0', c.c_int64, c.c_void_p, c.c_int)
        self.end = self.bind('whisper_full_get_segment_t1', c.c_int64, c.c_void_p, c.c_int)
        self.text = self.bind('whisper_full_get_segment_text', c.c_char_p, c.c_void_p, c.c_int)
        self.token_count = self.bind('whisper_full_n_tokens', c.c_int, c.c_void_p, c.c_int)
        self.token = self.bind(
            'grigdesk_whisper_token', c.c_char_p, c.c_void_p, c.c_int, c.c_int,
            c.POINTER(c.c_int64), c.POINTER(c.c_int64),
        )
        self.context = self.open(os.fsencode(weights))
        if not self.context:
            raise RuntimeError('whisper.cpp не смог загрузить веса модели')

    def bind(self, name, result, *args):
        function = getattr(self.lib, name)
        function.restype = result
        function.argtypes = args or (c.c_void_p,)
        return function

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.free(self.context)
        self.context = None

    def words(self, index, segment_start, segment_end):
        """Склеивает составные токены слова и сохраняет реальные метки модели."""
        partial = bytearray()
        words = []
        lower = segment_start
        upper = segment_start
        for token in range(self.token_count(self.context, index)):
            start, end = c.c_int64(), c.c_int64()
            text = self.token(self.context, index, token, c.byref(start), c.byref(end))
            if not text:
                continue
            if text[:1].isspace() and partial:
                self.append_word(words, partial, lower, upper)
                partial.clear()
            if not partial:
                lower = max(segment_start, start.value / 100)
                upper = lower
            partial.extend(text)
            upper = max(upper, min(segment_end, end.value / 100))
        self.append_word(words, partial, lower, upper)
        return words

    @staticmethod
    def append_word(words, raw, start, end):
        text = raw.decode(errors='replace').strip()
        start = max(start, words[-1].end) if words else start
        if text and end > start:
            words.append(SimpleNamespace(word=text, start=start, end=end))

    def transcribe(
        self, audio, *, language=None, beam_size=5, hotwords=None, initial_prompt=None,
        condition_on_previous_text=True, word_timestamps=False, vad_filter=False, vad_parameters=None,
    ):
        """Запускает Whisper на PCM и возвращает интервалы общего протокола worker."""
        pcm = audio if isinstance(audio, bytes) else decode_audio(audio)
        duration = len(pcm) / 32000
        info = SimpleNamespace(language=language, language_probability=0, duration=duration)
        if not pcm:
            return [], info
        # GGML принимает подсказку в начале контекста. Фильтр речи встроен
        # в декодер Whisper; отдельный Silero здесь не загружается.
        prompt = ' '.join(filter(None, (initial_prompt, hotwords))).encode() or None
        threads = min(4, len(os.sched_getaffinity(0)))
        result = self.decode(
            self.context, pcm, len(pcm) // 2, (language or 'auto').encode(), threads,
            beam_size, prompt, condition_on_previous_text, word_timestamps,
        )
        if result != 0:
            raise RuntimeError(f'Ошибка распознавания whisper.cpp ({result})')
        language_id = self.language_id(self.context)
        if language_id >= 0:
            info.language = self.language_name(language_id).decode()
        segments = []
        for index in range(self.count(self.context)):
            start = self.start(self.context, index) / 100
            end = min(self.end(self.context, index) / 100, duration)
            text = self.text(self.context, index).decode(errors='replace')
            if text.strip() and end > start:
                words = self.words(index, start, end) if word_timestamps else []
                segments.append(SimpleNamespace(text=text, start=start, end=end, words=words))
        return segments, info


def open_model(model_id):
    """Распознавание получает только локальные веса и никогда не скачивает их."""
    if not inspect_model(model_id)['cached']:
        raise FileNotFoundError('cached snapshot GGML отсутствует; сначала установите модель')
    return Model(model_path(model_id))
