// Проверяет временное хранение и распознавание голосового сообщения Telegram-пульта.
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';

import { transcribePultVoice } from '../../server/src/lib/telegram/pult/voice.ts';

async function wasRemoved(file) {
  try {
    await access(file);
    return false;
  } catch {
    return true;
  }
}

test('временный каталог голоса удаляется после успешного распознавания', async () => {
  let workDir = '';
  const text = await transcribePultVoice({
    bytes: Buffer.from('voice'),
    speechRuntime: {
      transcribe: async (options) => {
        workDir = options.workDir;
        await access(options.filePath);
        return { transcript: { text: '  проверь конвейер  ' } };
      },
    },
  });
  assert.deepEqual({ text, removed: await wasRemoved(workDir) }, {
    text: 'проверь конвейер',
    removed: true,
  });
});

test('временный каталог голоса удаляется при ошибке SpeechRuntime', async () => {
  let workDir = '';
  await assert.rejects(() => transcribePultVoice({
    bytes: Buffer.from('voice'),
    speechRuntime: {
      transcribe: async (options) => {
        workDir = options.workDir;
        throw new Error('движок не ответил');
      },
    },
  }), /движок не ответил/u);
  assert.equal(await wasRemoved(workDir), true);
});

test('временный каталог голоса удаляется при abort', async () => {
  let workDir = '';
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(() => transcribePultVoice({
    bytes: Buffer.from('voice'),
    signal: abort.signal,
    speechRuntime: {
      transcribe: async (options) => {
        workDir = options.workDir;
        assert.equal(options.signal.aborted, true);
        throw Object.assign(new Error('ход отменён'), { name: 'AbortError' });
      },
    },
  }), { name: 'AbortError' });
  assert.equal(await wasRemoved(workDir), true);
});
