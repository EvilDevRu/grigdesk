#!/usr/bin/env python3
# Распознавание речи из аудиофайла через faster-whisper (локально, офлайн).
# Вызывается из MCP-инструмента b24_ingest_recording.
#
# Контракт: единственный вывод в stdout — JSON-объект
#   {language, language_probability, duration, model, segments:[{start,end,text}]}
# Любые логи/прогресс — только в stderr, чтобы не ломать парсинг на стороне Node.
#
# Обычная транскрипция работает только с уже подготовленной моделью в HF_HOME.
# Сеть и скачивание разрешаются отдельному model-job, а не этому процессу.

import os
import sys
import json
import argparse


def resolve_snapshot(snapshot_download, args):
    """Находит canonical или разрешённый сервером alias только на pinned revision."""
    errors = []
    for repo in [args.model_repo, *getattr(args, 'model_alias', [])]:
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
    """Повторяет точную токенизацию и границу среза faster-whisper 1.2.1."""
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


def load_model(WhisperModel, args):
    """
    Fail-closed загрузка: первая диктовка никогда не начинает скрыто скачивать гигабайты.
    Отсутствующая модель должна дойти до Node как явная ошибка model missing.
    """
    from huggingface_hub import snapshot_download
    snapshot = resolve_snapshot(snapshot_download, args)
    return WhisperModel(
        snapshot,
        device=args.device,
        compute_type=args.compute_type,
        local_files_only=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description='faster-whisper транскрипция аудио в JSON')
    parser.add_argument('audio', help='путь к аудиофайлу (16 кГц mono wav и т.п.)')
    parser.add_argument('--model', default='medium', help='размер модели: tiny|base|small|medium|large-v3')
    parser.add_argument('--model-repo', required=True, help='HF repo из серверного allowlist')
    parser.add_argument('--model-revision', required=True, help='полный pinned commit SHA')
    parser.add_argument('--model-alias', action='append', default=[], help='разрешённый alias того же pinned snapshot')
    parser.add_argument('--lang', default='ru', help="язык речи; 'auto' — автоопределение")
    parser.add_argument('--device', default='cpu', help='cpu|cuda')
    parser.add_argument('--compute-type', default='int8', help='int8|int8_float16|float16|float32')
    parser.add_argument('--beam-size', default=5, type=int, help='ширина beam search')
    parser.add_argument('--hotwords', default=None, help='термины-подсказки для распознавания')
    parser.add_argument(
        '--no-condition-previous',
        dest='condition_on_previous_text',
        action='store_false',
        help='не использовать текст предыдущего сегмента как контекст',
    )
    parser.set_defaults(condition_on_previous_text=True)
    parser.add_argument('--vad-silence-ms', default=500, type=int, help='минимальная пауза VAD, мс')
    parser.add_argument(
        '--initial-prompt',
        default=None,
        help='стилевая подсказка первому окну: задаёт пунктуацию, регистр и разбивку на предложения',
    )
    parser.add_argument('--progress-file', default=None, help='куда писать прогресс {done,total} по ходу распознавания')
    args = parser.parse_args()

    # Импорт внутри main: ошибка импорта попадёт в stderr с ненулевым кодом,
    # а не уронит парсер аргументов.
    from faster_whisper import WhisperModel

    model = load_model(WhisperModel, args)
    hotwords_measure = measure_hotwords(model, args.hotwords)

    language = None if args.lang == 'auto' else args.lang
    initial_prompt = args.initial_prompt or None
    # Связка обязательна и проверена замером на этой же модели: голый initial_prompt
    # при condition_on_previous_text уводит модель в петлю — она повторяет текст самой
    # подсказки вместо речи (три одинаковых сегмента на 79 секунд записи). Выравнивание
    # по словам включает подавление повторов и снимает петлю. Поэтому word_timestamps
    # не отдельная настройка, а следствие промпта: разорвать пару нечем.
    segments, info = model.transcribe(
        args.audio,
        language=language,
        beam_size=args.beam_size,
        hotwords=args.hotwords,
        condition_on_previous_text=args.condition_on_previous_text,
        initial_prompt=initial_prompt,
        word_timestamps=bool(initial_prompt),
        vad_filter=True,                                   # отсекаем тишину/паузы
        vad_parameters={'min_silence_duration_ms': args.vad_silence_ms},
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
        **hotwords_measure,
    }
    json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
