#!/usr/bin/env python3
"""Синтез одной реплики голосом Piper.

Отдельный процесс, а не сервис: модель поднимается за доли секунды, а живущий
между репликами python держал бы память и переживал бы правки раздела.

Текст приходит на stdin. Аргументом он не передаётся намеренно: реплику пишет
человек или модель, и её место — не в командной строке.

В stdout уходит одна строка JSON с ФАКТАМИ о готовом файле: длительность и
пиковая громкость. Приёмка установки смотрит на них, чтобы отличить настоящую
речь от тишины нужной длины.
"""

from __future__ import annotations

import argparse
import array
import json
import sys
import wave

from piper import PiperVoice, SynthesisConfig


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--config", default=None)
    parser.add_argument("--out", required=True)
    # Темп задаётся множителем длины: больше единицы — медленнее речь.
    parser.add_argument("--length-scale", type=float, default=1.0)
    parser.add_argument("--volume", type=float, default=1.0)
    args = parser.parse_args()

    text = sys.stdin.read().strip()

    if not text:
        print(json.dumps({"error": "пустая реплика"}, ensure_ascii=False))
        return 2

    voice = PiperVoice.load(args.model, config_path=args.config)
    config = SynthesisConfig(length_scale=args.length_scale, volume=args.volume)

    with wave.open(args.out, "wb") as output:
        voice.synthesize_wav(text, output, syn_config=config)

    with wave.open(args.out, "rb") as produced:
        frames = produced.getnframes()
        rate = produced.getframerate()
        channels = produced.getnchannels()
        width = produced.getsampwidth()
        raw = produced.readframes(frames)

    peak = 0

    # Пик считается по 16-битным отсчётам через array: тянуть numpy ради одного
    # максимума незачем, а тишина в файле нужной длины — самая частая поломка
    # синтеза, и не заметить её нельзя.
    if width == 2 and raw:
        samples = array.array("h")
        samples.frombytes(raw[:len(raw) - len(raw) % 2])
        peak = max(abs(min(samples)), abs(max(samples))) if samples else 0

    print(json.dumps({
        "durationMs": round(frames / rate * 1000) if rate else 0,
        "sampleRate": rate,
        "channels": channels,
        "peak": min(peak / 32767, 1.0) if width == 2 else None,
    }, ensure_ascii=False))

    return 0


if __name__ == "__main__":
    sys.exit(main())
