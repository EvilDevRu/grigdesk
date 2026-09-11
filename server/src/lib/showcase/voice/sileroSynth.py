#!/usr/bin/env python3
"""Синтез одной реплики голосом Silero (v4, русский).

Отдельный процесс, а не сервис: модель поднимается за секунду, а живущий между
репликами python держал бы сотни мегабайт и переживал бы правки раздела.

Текст приходит на stdin. Аргументом он не передаётся намеренно: реплику пишет
человек или модель, и её место — не в командной строке.

Длинная реплика режется по предложениям: модель принимает ограниченный кусок
текста за вызов, и одна фраза на сто слов иначе обрывалась бы на полуслове.
Куски склеиваются с короткой паузой — так звучит и живая речь на границе фраз.

В stdout уходит одна строка JSON с ФАКТАМИ о готовом файле: длительность и
пиковая громкость. Приёмка установки смотрит на них, чтобы отличить настоящую
речь от тишины нужной длины.
"""

from __future__ import annotations

import argparse
import array
import json
import os
import re
import sys
import wave
from xml.sax.saxutils import escape

SAMPLE_RATE = 48000
CHUNK_LIMIT = 400
PAUSE_BETWEEN_CHUNKS_S = 0.25

# Темп в терминах SSML движка: у Silero три ступени prosody rate, и это ровно
# столько, сколько различает интерфейс.
RATES = {"slow": "slow", "normal": "medium", "fast": "fast"}


def split_text(text: str) -> list[str]:
    """Режет текст по границам предложений, не превышая предел куска."""
    sentences = [part.strip() for part in re.split(r"(?<=[.!?…])\s+", text) if part.strip()]
    chunks: list[str] = []
    current = ""

    for sentence in sentences:
        candidate = f"{current} {sentence}".strip()

        if current and len(candidate) > CHUNK_LIMIT:
            chunks.append(current)
            current = sentence
        else:
            current = candidate

        # Одно предложение длиннее предела режется по запятым: обрыв на полуслове
        # хуже лишней паузы.
        while len(current) > CHUNK_LIMIT:
            cut = current.rfind(",", 0, CHUNK_LIMIT)
            cut = cut if cut > 0 else CHUNK_LIMIT
            chunks.append(current[:cut].strip())
            current = current[cut:].strip(" ,")

    if current:
        chunks.append(current)

    return chunks


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--speaker", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--rate", default="normal", choices=sorted(RATES))
    parser.add_argument("--threads", type=int, default=0)
    args = parser.parse_args()

    text = sys.stdin.read().strip()

    if not text:
        print(json.dumps({"error": "пустая реплика"}, ensure_ascii=False))
        return 2

    import torch  # noqa: WPS433 — тяжёлый импорт после разбора аргументов

    torch.set_num_threads(args.threads or min(8, os.cpu_count() or 1))
    model = torch.package.PackageImporter(args.model).load_pickle("tts_models", "model")
    model.to(torch.device("cpu"))

    pieces = []
    pause = torch.zeros(int(SAMPLE_RATE * PAUSE_BETWEEN_CHUNKS_S))

    for index, chunk in enumerate(split_text(text)):
        ssml = (
            f'<speak><prosody rate="{RATES[args.rate]}">{escape(chunk)}</prosody></speak>'
        )
        audio = model.apply_tts(
            ssml_text=ssml,
            speaker=args.speaker,
            sample_rate=SAMPLE_RATE,
            put_accent=True,
            put_yo=True,
        )

        if index > 0:
            pieces.append(pause)

        pieces.append(audio)

    joined = torch.cat(pieces) if pieces else torch.zeros(0)
    samples = (joined * 32767).clamp(-32768, 32767).to(torch.int16).tolist()
    pcm = array.array("h", samples)

    with wave.open(args.out, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(pcm.tobytes())

    peak = max((abs(value) for value in samples), default=0)

    print(json.dumps({
        "durationMs": round(len(samples) / SAMPLE_RATE * 1000),
        "sampleRate": SAMPLE_RATE,
        "channels": 1,
        "peak": min(peak / 32767, 1.0),
    }, ensure_ascii=False))

    return 0


if __name__ == "__main__":
    sys.exit(main())
