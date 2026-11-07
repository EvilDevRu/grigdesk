import { readFile } from 'node:fs/promises';

import {
  createApplyFs,
  applyIntent,
  recoverApply,
} from '../../../server/src/lib/packageInstall/applyPackage.ts';
import { PluginInstallStateStore } from '../../../server/src/lib/packageInstall/stateStore.ts';
import { writeDurableFile } from '../../../server/src/lib/durableFile.ts';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));

if (config.now) {
  const OriginalDate = Date;

  globalThis.Date = class extends OriginalDate {
    /**
     * Fixture меняет только clock нового resolver process, а не реальные файлы.
     * Дата archive должна оставаться durable входом прежнего intent.
     */
    constructor(...args) {
      super(...(args.length > 0 ? args : [config.now]));
    }

    /**
     * Date.now согласован с constructor в этом изолированном child.
     * Host clock и другие test processes остаются прежними.
     */
    static now() {
      return OriginalDate.parse(config.now);
    }
  };
}

const fs = createApplyFs(config.roots);
const trace = [];
const store = new PluginInstallStateStore({
  statePath: config.statePath,
  hasWorkEvidence: async () => true,
  write: async (file, text) => {
    const state = JSON.parse(text);
    const phase = state.apply?.phase ?? state.job?.status ?? 'empty';

    await checkpoint(`before:write:${phase}`);
    await writeDurableFile(file, text);
    await checkpoint(`after:write:${phase}`);
  },
});

for (const method of ['rename', 'syncDir', 'ensureDir', 'removeCleanup']) {
  const original = fs[method];

  fs[method] = async (...args) => {
    const result = await original(...args);

    await checkpoint(`after:${method}`);

    return result;
  };
}

try {
  const result = config.operation === 'recover' ? await recoverApply(store, fs)
    : await applyIntent(config.intent, store, fs);

  await send({
    type: 'result',
    result,
    trace,
  });
} catch (error) {
  await send({
    type: 'failure',
    code: error?.code ?? 'unknown',
    trace,
  });
  process.exitCode = 1;
} finally {
  process.disconnect?.();
}

/**
 * Barrier регистрирует listener до отправки сигнала и держит IPC/timer до parent ACK.
 * SIGKILL parent-а происходит при живом child, после подтверждённого эффекта или записи.
 */
async function checkpoint(event) {
  const index = trace.length;

  trace.push(event);

  if (index !== config.barrierAt) {
    return;
  }

  process.channel?.ref();

  const holding = setInterval(() => {}, 1000);

  await new Promise((resolve, reject) => {
    const receive = (message) => {
      if (message?.type === 'continue') {
        process.off('message', receive);
        resolve();
      }
    };

    process.on('message', receive);
    process.send({
      type: 'barrier',
      index,
      event,
      held: true,
    }, (error) => {
      if (error) {
        reject(error);
      }
    });
  });
  clearInterval(holding);
}

/**
 * Последний результат доставляется до disconnect, чтобы exit не потерял IPC сообщение.
 * Только синтетические codes/trace выходят из child, payload и env не логируются.
 */
async function send(message) {
  await new Promise((resolve, reject) => process.send(message, (error) => error ? reject(error) : resolve()));
}
