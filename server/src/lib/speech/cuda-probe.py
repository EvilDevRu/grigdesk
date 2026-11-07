#!/usr/bin/env python3
# CUDA-canary: проверяет устройство, загрузку библиотек и, когда модель уже есть,
# делает короткий реальный инференс. Единственный stdout — JSON состояния.

import argparse
import ctypes
import json
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
    return None


def answer(state, reason=None, device=None):
    payload = {'state': state, 'reason': reason}
    if device is not None:
        payload['device'] = device
    json.dump(payload, sys.stdout, ensure_ascii=False)


def classify(error):
    message = str(error)
    lowered = message.lower()
    if any(token in lowered for token in ('libcublas', 'libcudnn', 'cannot open shared object')):
        return 'missing_library'
    if any(token in lowered for token in ('no cuda', 'cuda device', 'driver version')):
        return 'no_device'
    return 'probe_failed'


def main():
    parser = argparse.ArgumentParser(description='Проверка CUDA для faster-whisper')
    parser.add_argument('--model-path', default=None, help='подтверждённый локальный snapshot')
    parser.add_argument('--model-repo', default=None)
    parser.add_argument('--model-revision', default=None)
    parser.add_argument('--model-alias', action='append', default=[])
    args = parser.parse_args()

    try:
        import ctranslate2
        count = ctranslate2.get_cuda_device_count()
        if count < 1:
            answer('no_device', 'CUDA-устройство не найдено')
            return
        # CTranslate2 открывает cublas лениво при первом инференсе, поэтому проверяем
        # библиотеку явно даже без готовой модели.
        ctypes.CDLL('libcublas.so.12')
        model_path = args.model_path
        if not model_path and args.model_repo:
            from huggingface_hub import snapshot_download
            model_path = resolve_snapshot(snapshot_download, args)
        if model_path:
            import numpy
            from faster_whisper import WhisperModel
            model = WhisperModel(
                model_path,
                device='cuda',
                compute_type='float16',
                local_files_only=True,
            )
            segments, _ = model.transcribe(
                numpy.zeros(1600, dtype=numpy.float32),
                beam_size=1,
                vad_filter=False,
            )
            next(iter(segments), None)
        answer('ready', device=0)
    except OSError as error:
        answer('missing_library', str(error))
    except Exception as error:
        answer(classify(error), str(error))


if __name__ == '__main__':
    main()
