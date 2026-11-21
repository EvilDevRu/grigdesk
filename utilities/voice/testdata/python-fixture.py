#!/usr/bin/python3
# Имитирует импорт и синтез через настоящие stdin, argv и файл результата.
import json
import os
import struct
import sys


if sys.argv[1] == '-c':
    print('{"versions":{"piper-tts":"1.8.0","onnxruntime":"1.23.2"}}')
    sys.exit(0)

args = sys.argv[1:]
if args[:2] == ['-m', 'pip']:
    sys.exit(0)
text = sys.stdin.read()
if not text or not os.path.isfile(args[args.index('--model') + 1]):
    sys.exit(9)

record = os.getenv('VOICE_FIXTURE_RECORD')
if record:
    with open(record, 'w', encoding='utf-8') as log:
        json.dump({'text': text, 'args': args}, log)
rate = 48000 if '--speaker' in args else 22050
path = args[args.index('--out') + 1]
with open(path, 'wb') as audio:
    sample = struct.pack('<hhhh', 5000, -5000, 1000, -1000)
    header = struct.pack('<4sI4s4sIHHIIHH4sI', b'RIFF', 36 + len(sample), b'WAVE', b'fmt ',
                         16, 1, 1, rate, 2 * rate, 2, 16, b'data', len(sample))
    audio.write(b'RIFF fixture truncated' if os.getenv('VOICE_FIXTURE_CORRUPT') else header + sample)
print(json.dumps({'peak': 0.5, 'sampleRate': rate, 'channels': 1}))
