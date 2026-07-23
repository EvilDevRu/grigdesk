#!/usr/bin/env python3
# Распознавание речи из аудиофайла через faster-whisper (локально, офлайн).
# Вызывается из MCP-инструмента b24_ingest_recording.
#
# Контракт: единственный вывод в stdout — JSON-объект
#   {language, language_probability, duration, model, segments:[{start,end,text}]}
# Любые логи/прогресс — только в stderr, чтобы не ломать парсинг на стороне Node.
#
# Модель скачивается автоматически при первом запуске и кэшируется
# в HF_HOME (см. Dockerfile — /data/models; medium ~1.5 ГБ). На CPU работает в режиме int8.

import os
import sys
import json
import argparse


def load_model(WhisperModel, args):
    """
    Загрузка модели офлайн-first.

    faster-whisper при каждом запуске обращается к HuggingFace Hub, чтобы
    проверить ревизию модели. Если сеть к huggingface.co недоступна (прокси/VPN,
    офлайн-окружение), это валит распознавание с LocalEntryNotFoundError даже
    тогда, когда модель уже целиком лежит в кэше HF_HOME.

    Поэтому: сначала пробуем взять модель из кэша без сети (local_files_only),
    а ходить в интернет за скачиванием будем только если в кэше её реально нет.
    """
    # args.model может быть как именем (medium), так и путём к локальной модели —
    # local_files_only безопасен в обоих случаях.
    try:
        return WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
            local_files_only=True,
        )
    except Exception:
        # В кэше модели нет — качаем (нужна сеть). Лог в stderr, чтобы не ломать JSON в stdout.
        print(f'модель {args.model} не найдена в кэше, скачиваю с HuggingFace…', file=sys.stderr)
        return WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
            local_files_only=False,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description='faster-whisper транскрипция аудио в JSON')
    parser.add_argument('audio', help='путь к аудиофайлу (16 кГц mono wav и т.п.)')
    parser.add_argument('--model', default='medium', help='размер модели: tiny|base|small|medium|large-v3')
    parser.add_argument('--lang', default='ru', help="язык речи; 'auto' — автоопределение")
    parser.add_argument('--device', default='cpu', help='cpu|cuda')
    parser.add_argument('--compute-type', default='int8', help='int8|int8_float16|float16|float32')
    parser.add_argument('--progress-file', default=None, help='куда писать прогресс {done,total} по ходу распознавания')
    args = parser.parse_args()

    # Импорт внутри main: ошибка импорта попадёт в stderr с ненулевым кодом,
    # а не уронит парсер аргументов.
    from faster_whisper import WhisperModel

    model = load_model(WhisperModel, args)

    language = None if args.lang == 'auto' else args.lang
    segments, info = model.transcribe(
        args.audio,
        language=language,
        vad_filter=True,                                   # отсекаем тишину/паузы
        vad_parameters={'min_silence_duration_ms': 500},
    )

    total = round(info.duration or 0, 2)

    # Прогресс пишем атомарно (tmp + rename), чтобы читатель не поймал полуфайл.
    def write_progress(done: float) -> None:
        if not args.progress_file:
            return
        try:
            tmp = args.progress_file + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump({'done': round(done, 2), 'total': total}, f)
            os.replace(tmp, args.progress_file)
        except Exception:
            # прогресс — best-effort, его сбой не должен ронять распознавание
            pass

    write_progress(0.0)

    # segments — ленивый генератор: материализация здесь и запускает распознавание.
    # Тайм-код конца последнего сегмента / общая длительность = доля готовности.
    out_segments = []
    processed = 0
    for s in segments:
        text = s.text.strip()
        if text:
            out_segments.append({
                'start': round(s.start, 2),
                'end': round(s.end, 2),
                'text': text,
            })
        processed += 1
        if processed % 5 == 0:
            write_progress(s.end)

    write_progress(total)

    result = {
        'language': info.language,
        'language_probability': round(info.language_probability, 3),
        'duration': round(info.duration, 2),
        'model': args.model,
        'segments': out_segments,
    }
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
