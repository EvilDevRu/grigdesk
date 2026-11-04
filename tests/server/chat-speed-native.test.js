import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import claude from '../../server/src/lib/executors/claude.ts';

const SOURCE = `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
const settings = JSON.parse(args[args.lastIndexOf('--settings') + 1]);
const model = args[args.indexOf('--model') + 1];
const effort = args[args.indexOf('--effort') + 1];
fs.writeFileSync(process.env.SPEED_NATIVE_TRACE, JSON.stringify({ settings, model, effort }));
const say = (event) => process.stdout.write(JSON.stringify(event) + '\\n');

/**
 * Fake CLI передаёт native состояние; реальный collector адаптера строит пользовательскую ленту.
 * Ответ не обращается к сети, model prompt и пользовательские файлы здесь не исполняются.
 */
function answer(text) {
  say({ type: 'system', subtype: 'init', session_id: 'speed-native-sid', model,
    fast_mode_state: 'cooldown' });
  say({ type: 'assistant', session_id: 'speed-native-sid',
    message: { model, content: [{ type: 'text', text }] } });
  say({ type: 'result', subtype: 'success', session_id: 'speed-native-sid',
    result: text, num_turns: 1, fast_mode_state: 'cooldown' });
}

if (args.includes('--input-format')) {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const input = JSON.parse(line);

    if (input.type === 'control_request') {
      say({ type: 'control_response', response: { subtype: 'success', request_id: input.request_id } });

      return;
    }
    if (input.type !== 'user') {
      return;
    }

    const text = input.message.content.map((block) => block.text || '').join('');
    answer('готово');

    if (text === 'background') {
      setImmediate(() => answer('фон'));
    }
  });
} else {
  answer('готово');
}
`;

/**
 * Каждый child получает собственный исполняемый файл и trace аргументов.
 * Уборка каталога зарегистрирована до запуска; persistent handle закрывает сам тест.
 */
async function nativeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speed-native-'));
  const bin = path.join(root, 'claude.mjs');
  const trace = path.join(root, 'trace.json');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(bin, SOURCE, { mode: 0o755 });

  return {
    root,
    bin,
    trace,
  };
}

for (const transport of ['single', 'stream', 'persistent', 'background']) {
  for (const choice of ['fast', 'standard', undefined]) {
    test(`SPEED-NATIVE: ${transport} / ${String(choice)}`, { timeout: 10_000 }, async (t) => {
      const f = await nativeFixture(t);
      const inherited = { fastMode: true };
      const providerSettings = choice === undefined
        ? inherited : claude.chatSpeed?.apply(inherited, choice) || inherited;
      const options = {
        config: { claudeBin: f.bin },
        cwd: f.root,
        env: { ...process.env, SPEED_NATIVE_TRACE: f.trace },
        model: 'claude-speed-test',
        effort: 'high',
        providerSettings,
      };
      let result;

      if (transport === 'single' || transport === 'stream') {
        result = await claude.run({
          ...options,
          message: 'проверка',
          ...(transport === 'stream' ? { onInTurnReady() {} } : {}),
        });
      } else {
        let resolveBackground;
        const background = new Promise((resolve) => {
          resolveBackground = resolve;
        });
        const session = claude.session.open({
          ...options,
          hooks: { onBackground: resolveBackground },
        });

        try {
          const foreground = await session.send({
            message: transport === 'background' ? 'background' : 'проверка',
          });

          result = transport === 'background' ? await background : foreground;
        } finally {
          await session.close();
        }
      }

      assert.equal(result.reply === 'готово' || result.reply === 'фон', true);

      const warning = result.steps.some((step) => step.k === 'note'
        && step.text.includes('обычную скорость'));

      assert.equal(warning, choice === 'fast');

      const actual = JSON.parse(await fs.readFile(f.trace, 'utf8'));

      assert.equal(actual.settings.fastMode, choice !== 'standard');
      assert.equal(Object.hasOwn(actual.settings, 'chatSpeedMode'), false);
      assert.equal(actual.model, 'claude-speed-test');
      assert.equal(actual.effort, 'high');
    });
  }
}
