#!/usr/bin/env python3
# Проверка pinned snapshots через публичный API huggingface_hub. Путь к кэшу
# намеренно не собирается в Node: его вычисляет сама библиотека из env процесса.

import argparse
import glob
import json
import os
import sys


REQUIRED_FILES = ('config.json', 'model.bin', 'tokenizer.json')
HEX_DIGITS = frozenset('0123456789abcdefABCDEF')


def unresolved_incomplete_blobs(snapshot):
    blobs = os.path.join(os.path.dirname(os.path.dirname(snapshot)), 'blobs')
    unresolved = []
    for candidate in glob.glob(os.path.join(blobs, '*.incomplete')):
        filename = os.path.basename(candidate)
        stem = filename[:-len('.incomplete')]
        base, separator, suffix = stem.rpartition('.')
        # huggingface_hub 1.18 добавляет к etag уникальные восемь hex-символов.
        # Старый формат <etag>.incomplete тоже поддерживаем.
        blob = base if separator and len(suffix) == 8 and set(suffix) <= HEX_DIGITS else stem
        if not os.path.isfile(os.path.join(blobs, blob)):
            unresolved.append(filename)
    return unresolved


def inspect_model(snapshot_download, model):
    errors = []
    for repo in [model['repo'], *model.get('aliases', [])]:
        try:
            snapshot = snapshot_download(
                repo_id=repo,
                revision=model['revision'],
                local_files_only=True,
            )
            missing = [name for name in REQUIRED_FILES if not os.path.isfile(os.path.join(snapshot, name))]
            incomplete = unresolved_incomplete_blobs(snapshot)
            if missing or incomplete:
                details = []
                if missing:
                    details.append('нет файлов: ' + ', '.join(missing))
                if incomplete:
                    details.append('есть незавершённые blobs без финального файла')
                errors.append(f'{repo}: {"; ".join(details)}')
                continue
            # huggingface_hub 1.18 скачивает blob во временный файл с уникальным
            # суффиксом. Убитый worker может оставить такой orphan, а следующий
            # запуск успешно положит финальный blob рядом с ним. Такой superseded
            # temp не инвалидирует pinned snapshot; temp без соответствующего
            # финального blob выше остаётся fail-closed.
            return {
                'modelId': model['modelId'],
                'cached': True,
                'snapshotPath': snapshot,
                'resolvedRepo': repo,
                'reason': None,
            }
        except Exception as error:
            errors.append(str(error))
    return {
        'modelId': model['modelId'],
        'cached': False,
        'snapshotPath': None,
        'reason': errors[-1] if errors else 'snapshot не найден',
    }


def main():
    parser = argparse.ArgumentParser(description='Проверка локальных pinned speech models')
    parser.add_argument('--models-json', required=True)
    args = parser.parse_args()
    models = json.loads(args.models_json)
    from huggingface_hub import snapshot_download
    json.dump(
        {'models': [inspect_model(snapshot_download, model) for model in models]},
        sys.stdout,
        ensure_ascii=False,
    )


if __name__ == '__main__':
    main()
