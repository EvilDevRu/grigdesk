#!/usr/bin/env python3
# Живой session worker для псевдостриминга faster-whisper.
# Модель загружается один раз на диктовку; stdin/stdout — только newline-JSON.

import argparse
import json
import os
import stat
import sys


SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2


def send(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def resolve_snapshot(snapshot_download, args):
    errors = []
    for repo in [args.model_repo, *args.model_alias]:
        try:
            return snapshot_download(
                repo_id=repo,
                revision=args.model_revision,
                local_files_only=True,
            )
        except Exception as error:
            errors.append(error)
    if errors:
        raise errors[-1]
    raise RuntimeError('для модели не задан разрешённый репозиторий')


def error_code(error):
    text = f'{error.__class__.__name__}: {error}'
    if 'LocalEntryNotFoundError' in text or 'cached snapshot' in text or 'local_files_only' in text:
        return 'speech_model_missing'
    if 'faster_whisper' in text and 'No module named' in text:
        return 'speech_unavailable'
    return 'transcribe_failed'


def integer_field(request, name, minimum=0):
    value = request.get(name)
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError(f'{name} должен быть целым не меньше {minimum}')
    return value


def read_pcm_window(request):
    file_path = request.get('filePath')
    if not isinstance(file_path, str) or not file_path:
        raise ValueError('filePath обязателен')
    start_byte = integer_field(request, 'startByte')
    end_byte = integer_field(request, 'endByte', 1)
    offset_ms = integer_field(request, 'offsetMs')
    if start_byte % BYTES_PER_SAMPLE or end_byte % BYTES_PER_SAMPLE:
        raise ValueError('PCM boundaries должны быть выровнены по int16')
    if end_byte <= start_byte:
        raise ValueError('endByte должен быть больше startByte')

    descriptor = os.open(file_path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('PCM source должен быть обычным файлом')
        if end_byte > info.st_size:
            raise ValueError('PCM watermark ещё не записан')
        os.lseek(descriptor, start_byte, os.SEEK_SET)
        remaining = end_byte - start_byte
        chunks = []
        while remaining:
            chunk = os.read(descriptor, min(remaining, 1024 * 1024))
            if not chunk:
                raise ValueError('неполное PCM window')
            chunks.append(chunk)
            remaining -= len(chunk)
    finally:
        os.close(descriptor)
    return b''.join(chunks), start_byte, end_byte, offset_ms


def word_payload(word, offset_seconds):
    text = str(getattr(word, 'word', '') or '')
    if not text.strip():
        return None
    relative_start = max(0.0, float(getattr(word, 'start', 0.0) or 0.0))
    relative_end = max(relative_start, float(getattr(word, 'end', relative_start) or relative_start))
    start = relative_start + offset_seconds
    end = relative_end + offset_seconds
    return {
        'startMs': round(start * 1000),
        'endMs': round(end * 1000),
        'text': text,
    }


def decode(model, args, request, numpy):
    pcm, start_byte, end_byte, offset_ms = read_pcm_window(request)
    audio = numpy.frombuffer(pcm, dtype='<i2').astype(numpy.float32) / 32768.0
    language = None if args.lang == 'auto' else args.lang
    segments, info = model.transcribe(
        audio,
        language=language,
        beam_size=args.beam_size,
        hotwords=args.hotwords,
        condition_on_previous_text=args.condition,
        vad_filter=True,
        vad_parameters={'min_silence_duration_ms': args.vad_silence_ms},
        word_timestamps=True,
    )

    words = []
    offset_seconds = offset_ms / 1000
    for segment in segments:
        segment_words = list(getattr(segment, 'words', None) or [])
        if segment_words:
            for word in segment_words:
                payload = word_payload(word, offset_seconds)
                if payload:
                    words.append(payload)
            continue
        # На редком backend-ответе без word timestamps сохраняем хотя бы сегмент
        # как одну единицу LocalAgreement, не теряя распознанный текст.
        text = str(getattr(segment, 'text', '') or '')
        if text.strip():
            relative_start = max(0.0, float(getattr(segment, 'start', 0.0) or 0.0))
            relative_end = max(
                relative_start,
                float(getattr(segment, 'end', relative_start) or relative_start),
            )
            start = relative_start + offset_seconds
            end = relative_end + offset_seconds
            words.append({
                'startMs': round(start * 1000),
                'endMs': round(end * 1000),
                'text': text,
            })

    return {
        'model': args.model,
        'language': getattr(info, 'language', None),
        'languageProbability': round(float(getattr(info, 'language_probability', 0.0) or 0.0), 3),
        'window': {
            'startByte': start_byte,
            'endByte': end_byte,
            'offsetMs': offset_ms,
            'final': request.get('final') is True,
        },
        'words': words,
    }


def main():
    parser = argparse.ArgumentParser(description='Session worker псевдостриминга faster-whisper')
    parser.add_argument('--nonce', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--model-repo', required=True)
    parser.add_argument('--model-revision', required=True)
    parser.add_argument('--model-alias', action='append', default=[])
    parser.add_argument('--lang', default='ru')
    parser.add_argument('--device', default='cpu')
    parser.add_argument('--compute-type', default='int8')
    parser.add_argument('--beam-size', type=int, default=5)
    parser.add_argument('--hotwords', default=None)
    parser.add_argument('--vad-silence-ms', type=int, default=500)
    parser.add_argument('--no-condition-previous', dest='condition', action='store_false')
    parser.set_defaults(condition=True)
    args = parser.parse_args()

    try:
        import numpy
        from faster_whisper import WhisperModel
        from huggingface_hub import snapshot_download

        snapshot = resolve_snapshot(snapshot_download, args)
        model = WhisperModel(
            snapshot,
            device=args.device,
            compute_type=args.compute_type,
            local_files_only=True,
        )
        send({
            'type': 'ready',
            'nonce': args.nonce,
            'protocolVersion': 1,
            'audio': {
                'encoding': 'pcm_s16le',
                'sampleRate': SAMPLE_RATE,
                'channels': 1,
                'frameSamples': 1600,
            },
        })
    except Exception as error:
        send({'type': 'error', 'code': error_code(error), 'message': str(error)})
        return

    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get('requestId')
            if request.get('type') != 'decode' or not isinstance(request_id, str) or not request_id:
                raise ValueError('ожидался decode request с requestId')
            result = decode(model, args, request, numpy)
            send({'type': 'result', 'requestId': request_id, 'result': result})
        except Exception as error:
            send({
                'type': 'error',
                'requestId': request_id,
                'code': error_code(error),
                'message': str(error),
            })


if __name__ == '__main__':
    main()
