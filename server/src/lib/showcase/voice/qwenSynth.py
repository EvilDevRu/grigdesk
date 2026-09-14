#!/usr/bin/env python3
"""Синтез реплик голосом Qwen3-TTS (1.7B, CustomVoice) на видеокарте.

Два режима. Одноразовый: текст одной реплики на stdin, файл по `--out` — так
идёт приёмка установки; с флагом `--json` на stdin приходит объект
`{"text": ..., "instruct": ...}` — тон пишет человек или модель, и в командной
строке ему не место. Резидентный (`--serve`): модель читается с диска один раз
на задание, а запросы приходят построчно, JSON на строку, и на каждый уходит
строка ответа с тем же `id`; конец stdin — команда выйти. Между заданиями процесс
не живёт: пять гигабайт видеопамяти не держатся и не мешают проверке речи и
локальным моделям.

Модель выбирает манеру речи заново на каждую реплику: у одного и того же диктора
медианная высота тона от реплики к реплике гуляла на октаву (103–190 Гц в ролике
из семи сцен), и снижение temperature/top_k этого не лечит — стиль выбирается в
первых же токенах. Поэтому каждая реплика синтезируется в НЕСКОЛЬКИХ кандидатах
одним вызовом модели (цикл генерации упирается в процессор, и четыре кандидата
стоят почти как один), а в файл уходит ближайший к ОПОРНОЙ записи диктора —
фразе, синтезированной один раз на диктора и сохранённой рядом с моделью.
Нехватка видеопамяти на батче — ответ с кодом `oom`, а не смерть процесса:
число кандидатов делится пополам, а адаптер дробит свой батч и пробует снова.

Библиотеки Hugging Face переводятся в офлайн ДО импортов: модель лежит на диске
целиком, и ни один запрос наружу синтезу не нужен.

Коды выхода со своим смыслом: 2 — пустая реплика, 3 — не хватило видеопамяти,
4 — видеокарта не видна. В stdout уходит строка JSON с ФАКТАМИ о готовом файле:
длительность и пиковая громкость; приёмка установки отличает по ним речь от
тишины нужной длины. Отказ печатается и в stdout (JSON), и в stderr (текст).
"""

from __future__ import annotations

import os

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import argparse  # noqa: E402 — офлайн-режим должен быть выставлен до любых импортов
import hashlib  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import sys  # noqa: E402
import traceback  # noqa: E402
import wave  # noqa: E402

EXIT_EMPTY = 2
EXIT_OUT_OF_MEMORY = 3
EXIT_NO_CUDA = 4

LANGUAGE = "Russian"
# Потолок пика синтеза: -3 дБ полной шкалы, как у остальных локальных движков.
PEAK_CEILING = 0.708

OOM_MESSAGE = (
    "не хватило видеопамяти: освободите видеокарту (например, выгрузите модель Ollama)"
)
NO_CUDA_MESSAGE = "видеокарта не видна: Qwen3-TTS работает только на CUDA"

# Сколько кандидатов синтезировать на реплику, если запрос не сказал иначе.
# Четыре — предел батча по видеопамяти на восьми гигабайтах; замер 11.09.2026 на
# семи сценах: у «первого попавшегося» кандидата медианный F0 отходил от опорной
# записи до пяти полутонов (118–170 Гц), у ближайшего из четырёх — не дальше
# 1,3 полутона (147–171 Гц). Единица выключает отбор.
DEFAULT_CANDIDATES = 4

# Опорная запись диктора: одна и та же фраза на всех дикторах, синтезируется при
# первом обращении и лежит в подкаталоге модели. Из её кандидатов берётся самый
# «типичный» — ближайший к их середине, — чтобы якорем не стал случайный выброс.
ANCHOR_DIR = "anchors"
ANCHOR_PHRASE = (
    "Это опорная запись голоса: по ней все реплики ролика подбираются "
    "так, чтобы звучать одним и тем же голосом."
)

# Вес примет в расстоянии до опоры: полтора полутона высоты тона приравнены к
# двенадцати единицам MFCC-профиля. Высота весит больше: именно скачок тона
# слышен как «другой голос», а профиль подстраховывает от одинаковой высоты при
# другом тембре.
PITCH_SEMITONES_UNIT = 1.5
PROFILE_UNIT = 12.0

# Кадры тише десятой доли самого громкого — паузы и шум: у них нет высоты тона.
VOICED_RMS_RATIO = 0.1


class NoCuda(RuntimeError):
    """Видеокарты нет — синтезу негде работать."""


class OutOfMemory(RuntimeError):
    """Видеопамяти не хватило уже на чтение модели."""


def fail(message: str, code: int) -> int:
    """Отказ словами в оба потока: JSON для машины, текст для журнала."""
    print(json.dumps({"error": message}, ensure_ascii=False), flush=True)
    print(message, file=sys.stderr)

    return code


def emit(payload: dict) -> None:
    """Строка ответа: сразу в stdout, иначе адаптер ждал бы её до конца буфера."""
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def read_request(use_json: bool) -> tuple[str, str | None]:
    """Реплика и указание со stdin: текст или объект с текстом и указанием."""
    raw = sys.stdin.read()

    if not use_json:
        return raw.strip(), None

    payload = json.loads(raw or "{}")
    text = str(payload.get("text") or "").strip()
    instruct = payload.get("instruct")

    return text, (str(instruct).strip() or None) if instruct else None


def load_model(model_dir: str):
    """Модель на видеокарте. Тяжёлые импорты — после разбора аргументов.

    Невидимая видеокарта и нехватка памяти при чтении модели — отказы со своим
    кодом выхода: адаптер называет их словами и действием.
    """
    import torch  # noqa: WPS433

    if not torch.cuda.is_available():
        raise NoCuda(NO_CUDA_MESSAGE)

    from qwen_tts import Qwen3TTSModel  # noqa: WPS433

    try:
        return Qwen3TTSModel.from_pretrained(
            model_dir,
            device_map="cuda:0",
            dtype=torch.bfloat16,
        )
    except torch.cuda.OutOfMemoryError as error:
        raise OutOfMemory(OOM_MESSAGE) from error


def write_wave(audio, sample_rate: int, out: str) -> dict:
    """Волна в 16-битный файл с пиком не выше -3 дБ; возвращает факты о файле.

    В 16 бит волна у самой единицы упирается в потолок, и самопроверка речи
    жаловалась бы на перегруз. Громкость целиком выравнивает сборка ролика.
    """
    import numpy as np  # noqa: WPS433

    audio = np.asarray(audio, dtype=np.float32).reshape(-1)
    peak_level = float(np.abs(audio).max()) if audio.size else 0.0

    if peak_level > PEAK_CEILING:
        audio = audio * (PEAK_CEILING / peak_level)

    samples = np.clip(audio * 32767, -32768, 32767).astype(np.int16)

    with wave.open(out, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(samples.tobytes())

    peak = int(np.abs(samples.astype(np.int32)).max()) if samples.size else 0

    return {
        "durationMs": round(samples.size / sample_rate * 1000),
        "sampleRate": sample_rate,
        "channels": 1,
        "peak": min(peak / 32767, 1.0),
    }


def speech_features(audio, sample_rate: int) -> dict:
    """Приметы голоса реплики: медианная высота тона и средний спектральный профиль.

    Высота — yin по озвученным кадрам; профиль — средние MFCC без нулевого
    коэффициента (он про громкость, а не про тембр). Обе приметы почти не зависят
    от текста реплики, поэтому по ним можно сравнивать разные фразы одного диктора.
    """
    import librosa  # noqa: WPS433 — зависимость qwen_tts, отдельной установки не нужно
    import numpy as np  # noqa: WPS433

    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    pitch_track = librosa.yin(samples, fmin=60, fmax=400, sr=sample_rate, frame_length=2048)
    loudness = librosa.feature.rms(y=samples, frame_length=2048, hop_length=512)[0]
    frames = min(len(pitch_track), len(loudness))
    voiced = (
        pitch_track[:frames][loudness[:frames] > loudness[:frames].max() * VOICED_RMS_RATIO]
        if frames else np.array([])
    )
    profile = librosa.feature.mfcc(y=samples, sr=sample_rate, n_mfcc=13).mean(axis=1)[1:]

    return {
        "pitch": float(np.median(voiced)) if voiced.size else 0.0,
        "profile": [float(value) for value in profile],
    }


def voice_distance(own: dict, anchor: dict) -> float:
    """Расстояние между двумя записями одного диктора в единицах «заметно на слух»."""
    if own["pitch"] <= 0 or anchor["pitch"] <= 0:
        return math.inf

    semitones = abs(12 * math.log2(own["pitch"] / anchor["pitch"]))
    profile = math.dist(own["profile"], anchor["profile"])

    return semitones / PITCH_SEMITONES_UNIT + profile / PROFILE_UNIT


def generate_candidates(model, text: str, speaker: str, instruct: str | None, count: int):
    """Кандидаты одной реплики одним вызовом модели.

    Не влезший в видеопамять батч не роняет реплику: число кандидатов делится
    пополам, и только одиночный кандидат отдаёт нехватку памяти наверх.
    """
    import torch  # noqa: WPS433

    while True:
        try:
            return model.generate_custom_voice(
                text=[text] * count,
                speaker=[speaker] * count,
                language=LANGUAGE,
                instruct=instruct or None,
            )
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()

            if count == 1:
                raise

            count = max(1, count // 2)


def anchor_of(model, model_dir: str, speaker: str) -> dict:
    """Приметы опорной записи диктора; при первом обращении запись создаётся.

    Кандидаты опорной фразы сравниваются со своей серединой (медиана высоты,
    средний профиль), и опорой становится ближайший к ней. Волна сохраняется
    рядом с приметами: человек может её послушать и понять, под что подгоняются
    сцены.
    """
    import numpy as np  # noqa: WPS433
    import torch  # noqa: WPS433

    anchors_dir = os.path.join(model_dir, ANCHOR_DIR)
    facts_file = os.path.join(anchors_dir, f"{speaker}.json")

    if os.path.exists(facts_file):
        with open(facts_file, encoding="utf-8") as stored:
            return json.load(stored)

    digest = hashlib.sha256(f"{speaker}\n{ANCHOR_PHRASE}".encode("utf-8")).digest()

    torch.manual_seed(int.from_bytes(digest[:4], "big"))

    wavs, sample_rate = generate_candidates(model, ANCHOR_PHRASE, speaker, None, DEFAULT_CANDIDATES)
    features = [speech_features(wav, int(sample_rate)) for wav in wavs]
    centre = {
        "pitch": float(np.median([item["pitch"] for item in features])),
        "profile": np.mean([item["profile"] for item in features], axis=0).tolist(),
    }
    chosen = min(range(len(features)), key=lambda index: voice_distance(features[index], centre))
    anchor = {**features[chosen], "phrase": ANCHOR_PHRASE, "speaker": speaker}

    os.makedirs(anchors_dir, mode=0o700, exist_ok=True)
    write_wave(wavs[chosen], int(sample_rate), os.path.join(anchors_dir, f"{speaker}.wav"))

    with open(facts_file, "w", encoding="utf-8") as stored:
        json.dump(anchor, stored, ensure_ascii=False, indent=1)

    return anchor


def synthesize(model, model_dir: str, items: list[dict]) -> list[dict]:
    """Реплики запроса по одной, каждая — в кандидатах; факты в том же порядке.

    Параметра seed у модели нет, а повтор одной и той же реплики должен звучать
    одинаково: семя выводится из её текста, и соседи по запросу на него не влияют.
    Из кандидатов в файл уходит ближайший к опорной записи диктора; поле
    `candidates` запроса меняет их число, единица выключает отбор.
    """
    import torch  # noqa: WPS433

    texts = [str(item.get("text") or "").strip() for item in items]

    if not items or any(not text for text in texts):
        raise ValueError("пустая реплика")

    results = []

    for item, text in zip(items, texts):
        speaker = str(item["speaker"])
        instruct = str(item.get("instruct") or "").strip() or None
        count = max(1, int(item.get("candidates") or DEFAULT_CANDIDATES))
        anchor = anchor_of(model, model_dir, speaker) if count > 1 else None
        digest = hashlib.sha256(text.encode("utf-8")).digest()

        torch.manual_seed(int.from_bytes(digest[:4], "big"))

        wavs, sample_rate = generate_candidates(model, text, speaker, instruct, count)
        chosen = 0
        distance = None

        if anchor is not None and len(wavs) > 1:
            distances = [voice_distance(speech_features(wav, int(sample_rate)), anchor) for wav in wavs]
            chosen = min(range(len(distances)), key=distances.__getitem__)
            distance = round(distances[chosen], 2)

        facts = write_wave(wavs[chosen], int(sample_rate), str(item["out"]))

        results.append({**facts, "candidates": len(wavs), "chosen": chosen + 1, "anchorDistance": distance})

    return results


def serve(model, model_dir: str, default_speaker: str) -> int:
    """Резидентный режим: запрос на строку, ответ на строку, выход по концу stdin.

    Отказ запроса не роняет процесс: он уходит ответом с причиной и кодом, а
    трассировка — в stderr для журнала. После нехватки видеопамяти кэш памяти
    отпускается, и следующий, меньший, запрос обслуживается как обычно.
    """
    import torch  # noqa: WPS433

    for line in sys.stdin:
        line = line.strip()

        if not line:
            continue

        request = json.loads(line)
        request_id = str(request.get("id", ""))
        items = [
            {**item, "speaker": item.get("speaker") or default_speaker}
            for item in request.get("items", [])
        ]

        try:
            results = synthesize(model, model_dir, items)
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            emit({"id": request_id, "error": OOM_MESSAGE, "code": "oom"})
            continue
        except Exception as error:  # noqa: BLE001 — любой отказ запроса уходит ответом
            traceback.print_exc(file=sys.stderr)
            emit({"id": request_id, "error": str(error), "code": "failed"})
            continue

        # Между запросами процесс держит только веса: кэш аллокатора после батча
        # тянет к пику, а видеокарту делят другие модели.
        torch.cuda.empty_cache()
        emit({"id": request_id, "results": results})

    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--speaker", required=True)
    parser.add_argument("--out")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--serve", action="store_true")
    args = parser.parse_args()

    if not args.serve:
        text, instruct = read_request(args.json)

        if not text:
            return fail("пустая реплика", EXIT_EMPTY)

        if not args.out:
            return fail("не указан файл результата", EXIT_EMPTY)

    try:
        model = load_model(args.model_dir)
    except NoCuda:
        return fail(NO_CUDA_MESSAGE, EXIT_NO_CUDA)
    except OutOfMemory:
        return fail(OOM_MESSAGE, EXIT_OUT_OF_MEMORY)

    import torch  # noqa: WPS433

    if args.serve:
        return serve(model, args.model_dir, args.speaker)

    try:
        facts = synthesize(model, args.model_dir, [{
            "text": text,
            "instruct": instruct,
            "speaker": args.speaker,
            "out": args.out,
        }])
    except torch.cuda.OutOfMemoryError:
        return fail(OOM_MESSAGE, EXIT_OUT_OF_MEMORY)

    emit(facts[0])

    return 0


if __name__ == "__main__":
    sys.exit(main())
