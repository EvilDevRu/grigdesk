#!/usr/bin/env python3
# Одноразовый процесс прогрева: загружает модель, сообщает ready и ждёт по stdin
# ровно один локальный файл. stdout — только newline-JSON protocol.

import argparse
import json
import math
import os
import sys


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


def measure_hotwords(model, hotwords):
    if not hotwords:
        return {'hotwordsTokens': 0, 'hotwordsTruncated': False}
    encoded = model.hf_tokenizer.encode(
        ' ' + hotwords.strip(),
        add_special_tokens=False,
    )
    tokens = len(encoded.ids)
    limit = model.max_length // 2 - 1
    return {
        'hotwordsTokens': tokens,
        'hotwordsTruncated': tokens > limit,
    }


def send(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def error_code(error):
    text = f'{error.__class__.__name__}: {error}'
    if 'LocalEntryNotFoundError' in text or 'cached snapshot' in text or 'local_files_only' in text:
        return 'speech_model_missing'
    if 'faster_whisper' in text and 'No module named' in text:
        return 'speech_unavailable'
    return 'transcribe_failed'


def write_progress(progress_file, done, total):
    if not progress_file:
        return
    try:
        tmp = progress_file + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as file:
            json.dump({'done': round(done, 2), 'total': round(total, 2)}, file)
        os.replace(tmp, progress_file)
    except Exception:
        pass


def timestamp_value(value):
    """Сохраняет недоверенную границу для строгой проверки на Node-стороне."""
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return round(result, 3) if math.isfinite(result) else None


def main():
    parser = argparse.ArgumentParser(description='Прогрев faster-whisper перед upload')
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
        from faster_whisper import WhisperModel
        from huggingface_hub import snapshot_download
        snapshot = resolve_snapshot(snapshot_download, args)
        model = WhisperModel(
            snapshot,
            device=args.device,
            compute_type=args.compute_type,
            local_files_only=True,
        )
        hotwords_measure = measure_hotwords(model, args.hotwords)
        send({'type': 'ready', 'nonce': args.nonce})
        line = sys.stdin.readline()
        if not line:
            return
        request = json.loads(line)
        if request.get('type') != 'transcribe':
            raise ValueError('ожидался transcribe request')
        word_timestamps = request.get('wordTimestamps', False)
        if not isinstance(word_timestamps, bool):
            raise ValueError('wordTimestamps должен быть boolean')
        language = None if args.lang == 'auto' else args.lang
        segments, info = model.transcribe(
            request['filePath'],
            language=language,
            beam_size=args.beam_size,
            hotwords=args.hotwords,
            condition_on_previous_text=args.condition,
            vad_filter=True,
            vad_parameters={'min_silence_duration_ms': args.vad_silence_ms},
            word_timestamps=word_timestamps,
        )
        total = round(info.duration or 0, 2)
        write_progress(request.get('progressFile'), 0, total)
        output = []
        words = []
        for index, segment in enumerate(segments, start=1):
            if word_timestamps:
                for word in list(getattr(segment, 'words', None) or []):
                    words.append({
                        'start': timestamp_value(getattr(word, 'start', None)),
                        'end': timestamp_value(getattr(word, 'end', None)),
                        'text': str(getattr(word, 'word', '') or '').strip(),
                    })
            text = segment.text.strip()
            if text:
                output.append({
                    'start': round(segment.start, 2),
                    'end': round(segment.end, 2),
                    'text': text,
                })
            if index % 5 == 0:
                write_progress(request.get('progressFile'), segment.end, total)
        write_progress(request.get('progressFile'), total, total)
        send({
            'type': 'result',
            'requestId': request['requestId'],
            'result': {
                'language': info.language,
                'language_probability': round(info.language_probability, 3),
                'duration': total,
                'model': args.model,
                'segments': output,
                'words': words,
                'word_timestamps': word_timestamps,
                **hotwords_measure,
            },
        })
    except Exception as error:
        send({
            'type': 'error',
            'code': error_code(error),
            'message': str(error),
        })


if __name__ == '__main__':
    main()
