// Изолированный CLI voice для тестов службы: каталог и WAV не требуют сети/моделей.
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Настоящий процесс CLI получает argv, пишет трассу и возвращает валидный WAV.
 * Готовность задаёт тест; ни облако, ни установщик Python здесь не запускаются.
 */
export async function createFakeShowcaseVoice(root, { ready = ['silero'], wav = null } = {}) {
  const bin = path.join(root, 'fake-voice');
  const marker = path.join(root, 'voice-marker');
  const wave = wav ?? `${marker}.wav`;

  await mkdir(root, { recursive: true });

  if (!wav) {
    const rate = 48000;
    const samples = rate * 1.5;
    const bytes = Buffer.alloc(44 + samples * 2);

    bytes.write('RIFF', 0);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(rate, 24);
    bytes.writeUInt32LE(rate * 2, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36);
    bytes.writeUInt32LE(samples * 2, 40);

    for (let index = 0; index < samples; index += 1) {
      bytes.writeInt16LE(Math.round(Math.sin(index * 330 * 2 * Math.PI / rate) * 8192), 44 + index * 2);
    }

    await writeFile(wave, bytes);
  }

  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const marker = ${JSON.stringify(marker)};
const ready = new Set(${JSON.stringify(ready)});
const wave = ${JSON.stringify(wave)};
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const service = args.includes('--service') ? flag('--service') : 'model-studio';
const engine = flag('--engine');
fs.appendFileSync(marker + '.argv', JSON.stringify(args) + '\\n');
const rows = [
  { id: 'qwen', service, model: service === 'model-studio' ? 'qwen3-tts-flash' : 'qwen-audio-3.0-tts-plus' },
  { id: 'piper', service: null, model: 'irina' },
  { id: 'silero', service: null, model: 'v5_5_ru' },
];
const key = (row) => row.id === 'qwen'
  ? (row.service === 'model-studio' ? 'qwen-studio' : 'qwen-token') : row.id;
if (args[0] === 'version') { console.log('voice 0.1.0 (test)'); process.exit(0); }
if (args[0] === 'engines') {
  console.log(JSON.stringify(rows.map(row => ({ ...row,
    status: ready.has(key(row)) ? 'ready' : 'blocked',
    reason: ready.has(key(row)) ? '' : 'Движок не установлен или нет ключа.',
    install: 'Проверьте настройку voice.',
  }))));
} else if (args[0] === 'models') {
  console.log(JSON.stringify(rows.map(row => ({ ...row, capabilities: {
    languages: ['ru'], pace: true, stress: row.id === 'silero', maxChars: 2000, formats: ['wav'],
  } }))));
} else if (args[0] === 'voices') {
  const row = rows.find(row => row.id === engine);
  const id = engine === 'qwen' ? 'Cherry' : engine === 'piper' ? 'irina' : 'xenia';
  console.log(JSON.stringify([{ id, name: id, languages: ['ru'], engine,
    available: ready.has(key(row)), reason: ready.has(key(row)) ? '' : 'Не установлен.',
  }]));
} else if (args[0] === 'generate') {
  const text = flag('--text');
  const out = flag('--out');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(wave, out);
  fs.appendFileSync(marker + '.stdin', text + '\\n');
  fs.appendFileSync(marker + '.requests', JSON.stringify({ items: [{ text }], engine, service }) + '\\n');
  console.log(JSON.stringify({ file: out, ignoredDirections: [], warnings: [] }));
} else if (args[0] === 'install') {
  console.error('Пакет установлен.');
  console.log('{}');
} else { process.exit(2); }
`;

  await writeFile(bin, source, 'utf8');
  await chmod(bin, 0o755);

  return {
    voiceBin: bin,
    voiceDataDir: path.join(root, 'voice-data'),
    voiceCloudEnv: () => ({}),
    marker,
    stdin: `${marker}.stdin`,
    requests: `${marker}.requests`,
    calls: `${marker}.argv`,
  };
}
