#!/usr/bin/env python3
"""Синтез реплик голосом Silero (v5.5, русский).

Два режима. Одноразовый: текст одной реплики на stdin, файл по `--out` — так
идёт приёмка установки. Резидентный (`--serve`): модель поднимается один раз на
задание, а запросы приходят построчно, JSON на строку, и на каждый уходит строка
ответа с тем же `id`; конец stdin — команда выйти. Между заданиями процесс не
живёт: сотни мегабайт памяти не держатся, а правки раздела его не переживают.

Текст приходит на stdin в обоих режимах. Аргументом он не передаётся намеренно:
реплику пишет человек или модель, и её место — не в командной строке.

Текст уже размечен адаптером: `+` перед ударной гласной движок понимает сам в
режиме SSML, а пауза приходит служебным токеном из символов частного диапазона
Unicode и превращается в `<break>` ПОСЛЕ экранирования — иначе тег экранировался бы
вместе с текстом. Латиницу и цифры Silero не читает; такой текст отвергает адаптер
до запуска, здесь его не бывает.

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

# Темп в терминах SSML движка: пять ступеней интерфейса ложатся на пять ступеней
# prosody rate, которые Silero различает (замерено на одной фразе: от 9,5 с на
# x-slow до 3,2 с на x-fast).
RATES = {
    "slowest": "x-slow",
    "slow": "slow",
    "normal": "medium",
    "fast": "fast",
    "fastest": "x-fast",
}
# Токен паузы адаптера: \uE000<мс>\uE001. Символы частного диапазона в тексте
# невозможны — адаптер вычищает их до разметки.
PAUSE_TOKEN = re.compile("\ue000(\\d+)\ue001")
# Потолок пика синтеза: -3 дБ полной шкалы.
PEAK_CEILING = 0.708


def to_ssml(chunk: str) -> str:
    """Экранирует кусок и подставляет паузы: токен ставится ПОСЛЕ escape()."""
    escaped = escape(chunk)

    return PAUSE_TOKEN.sub(lambda match: f'<break time="{match.group(1)}ms"/>', escaped)


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


def load_model(path: str, threads: int):
    """Модель на процессоре: тяжёлый импорт torch — после разбора аргументов."""
    import torch  # noqa: WPS433

    torch.set_num_threads(threads or min(8, os.cpu_count() or 1))
    model = torch.package.PackageImporter(path).load_pickle("tts_models", "model")
    model.to(torch.device("cpu"))

    return model


def synthesize(model, text: str, speaker: str, rate: str, out: str) -> dict:
    """Одна реплика в файл. Возвращает факты о готовом файле."""
    import torch  # noqa: WPS433

    pieces = []
    pause = torch.zeros(int(SAMPLE_RATE * PAUSE_BETWEEN_CHUNKS_S))

    for index, chunk in enumerate(split_text(text)):
        ssml = (
            f'<speak><prosody rate="{RATES[rate]}">{to_ssml(chunk)}</prosody></speak>'
        )
        audio = model.apply_tts(
            ssml_text=ssml,
            speaker=speaker,
            sample_rate=SAMPLE_RATE,
            put_accent=True,
            put_yo=True,
        )

        if index > 0:
            pieces.append(pause)

        pieces.append(audio)

    joined = torch.cat(pieces) if pieces else torch.zeros(0)

    # Модель отдаёт волну с пиками у самой единицы, и в 16 бит они упираются в потолок:
    # самопроверка речи честно жаловалась на перегруз в каждой сцене. Пик приводится к
    # -3 дБ; громкость целиком всё равно выравнивает сборка ролика.
    peak_level = float(joined.abs().max()) if joined.numel() else 0.0

    if peak_level > PEAK_CEILING:
        joined = joined * (PEAK_CEILING / peak_level)

    samples = (joined * 32767).clamp(-32768, 32767).to(torch.int16).tolist()
    pcm = array.array("h", samples)

    with wave.open(out, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(pcm.tobytes())

    peak = max((abs(value) for value in samples), default=0)

    return {
        "durationMs": round(len(samples) / SAMPLE_RATE * 1000),
        "sampleRate": SAMPLE_RATE,
        "channels": 1,
        "peak": min(peak / 32767, 1.0),
    }


def emit(payload: dict) -> None:
    """Строка ответа: сразу в stdout, иначе адаптер ждал бы её до конца буфера."""
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def serve(model, default_speaker: str, default_rate: str) -> int:
    """Резидентный режим: запрос на строку, ответ на строку, выход по концу stdin.

    Отказ одной реплики не роняет процесс: он уходит ответом с причиной, а
    трассировка — в stderr для журнала. Следующий запрос обслуживается как обычно.
    """
    import traceback

    for line in sys.stdin:
        line = line.strip()

        if not line:
            continue

        request = json.loads(line)
        request_id = str(request.get("id", ""))

        try:
            results = []

            for item in request.get("items", []):
                text = str(item.get("text") or "").strip()

                if not text:
                    raise ValueError("пустая реплика")

                results.append(synthesize(
                    model,
                    text,
                    str(item.get("speaker") or default_speaker),
                    str(item.get("rate") or default_rate),
                    str(item["out"]),
                ))

            emit({"id": request_id, "results": results})
        except Exception as error:  # noqa: BLE001 — любой отказ реплики уходит ответом
            traceback.print_exc(file=sys.stderr)
            emit({"id": request_id, "error": str(error), "code": "failed"})

    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--speaker", required=True)
    parser.add_argument("--out")
    parser.add_argument("--rate", default="normal", choices=sorted(RATES))
    parser.add_argument("--threads", type=int, default=0)
    parser.add_argument("--serve", action="store_true")
    args = parser.parse_args()

    if args.serve:
        return serve(load_model(args.model, args.threads), args.speaker, args.rate)

    if not args.out:
        print(json.dumps({"error": "не указан файл результата"}, ensure_ascii=False))
        return 2

    text = sys.stdin.read().strip()

    if not text:
        print(json.dumps({"error": "пустая реплика"}, ensure_ascii=False))
        return 2

    model = load_model(args.model, args.threads)

    emit(synthesize(model, text, args.speaker, args.rate, args.out))

    return 0


if __name__ == "__main__":
    sys.exit(main())
