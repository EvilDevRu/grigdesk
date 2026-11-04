#!/usr/bin/env python3
# Проверка настоящего файлового декодера без модели, сети и временных файлов.
# Одного импорта недостаточно: несовместимый PyAV падает только при чтении аудио.

import io
import wave

from faster_whisper.audio import decode_audio


def main():
    """
    Пропускает короткий WAV через тот же декодер, что читает запись диктовки.
    Неверная длительность и исключение означают неготовность окружения речи.
    """
    sample_rate = 16000
    sample_count = 1600
    audio = io.BytesIO()

    with wave.open(audio, 'wb') as recording:
        recording.setnchannels(1)
        recording.setsampwidth(2)
        recording.setframerate(sample_rate)
        recording.writeframes(b'\x00\x00' * sample_count)

    audio.seek(0)
    samples = decode_audio(audio, sampling_rate=sample_rate)

    if len(samples) != sample_count:
        raise RuntimeError('Декодер аудио вернул неверное число сэмплов')


if __name__ == '__main__':
    main()
