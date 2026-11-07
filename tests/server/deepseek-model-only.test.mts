import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { createRequire } from 'node:module';

import deepseek from '../../server/src/lib/executors/deepseek.ts';
import { createPluginRuntimeServices } from '../../server/src/modules/plugins/runtimeServices.ts';
import { startDeepSeekServer } from '../../server/src/lib/deepseek/serverRuntime.ts';
import { ensureGlmTestRuntime } from '../helpers/glmTestRuntime.mts';
import { startDeepSeekLoopback } from '../helpers/deepseekLoopback.mts';
import { writeGlmEgressGuard } from '../helpers/glmEgressGuard.mts';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const WebSocket = requireServer('ws');

const adapter = deepseek as unknown as Record<string, any>;
/**
 * Меняется только обратный wire snapshot, реальный выбор модели и ELF сохраняются.
 * Защита должна отказаться до prompt именно по прочитанному подтверждению.
 */
function rewriteModelSnapshot(t: TestContext, field: string) {
  const emit = WebSocket.prototype.emit;

  t.mock.method(WebSocket.prototype, 'emit', function(this: any, name: string, ...args: any[]) {
    if (name === 'message') {
      const frame = JSON.parse(String(args[0]));
      const next = frame.value?.type === 'snapshot'
        ? frame.value.projections?.values?.modelSelection?.next : null;

      if (next) {
        next[field] = 'PRIVATE_SNAPSHOT_POISON';
        args[0] = Buffer.from(JSON.stringify(frame));
      }
    }

    return emit.call(this, name, ...args);
  });
}

for (const mismatch of [null, 'provider', 'model', 'reasoningEffort', 'showcase-timeout']) {
  test(`CORE-MODEL/DeepSeek: capability, core и snapshot=${mismatch}`, async (t) => {
    if (mismatch && mismatch !== 'showcase-timeout') {
      rewriteModelSnapshot(t, mismatch);
    }

    const selected = await ensureGlmTestRuntime();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-model-only-'));
    const mock = await startDeepSeekLoopback();
    const guard = await writeGlmEgressGuard(root);
    const receipts: unknown[] = [];

    t.after(async () => {
      await mock.stop();
      await fs.rm(root, {
        recursive: true,
        force: true
      });
    });

    const runUntrusted = async (input: any) => adapter.runUntrusted?.({
      ...input,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        DEEPSEEK_API_KEY: 'synthetic'
      },
      startServer: async (launch: any) => {
        const rows = JSON.parse(await fs.readFile(launch.overlayPath, 'utf8'));

        rows.push({
          id: 'llm-deepseek',
          config: {
            baseURL: mock.endpoint,
            retryPolicy: {
              mode: 'normal',
              maxRetries: 0
            }
          }
        });
        rows.find((row: any) => row.insert).insert.push({
          id: 'loopback-only',
          name: pathToFileURL(guard).href
        });
        await fs.writeFile(launch.overlayPath, JSON.stringify(rows));

        return startDeepSeekServer(launch);
      },
    });
    const runtime = createPluginRuntimeServices({
      config: selected.config,
      listProjects: async () => [],
      environment: () => {
        throw new Error('unused');
      },
      project: async () => {
        throw new Error('unused');
      },
      sandboxes: async () => {
        throw new Error('unused');
      },
      holdSandbox: async () => {
        throw new Error('unused');
      },
      resolveTarget: async () => ({
        ok: true,
        ref: {
          provider: 'deepseek',
          model: '["deepseek-official","deepseek-v4-flash"]'
        },
        effort: 'high',
        executor: {
          ...adapter,
          runUntrusted
        }
      }),
    });

    assert.equal(adapter.untrustedInput?.text, true);
    assert.equal(adapter.untrustedInput?.images, false);

    if (mismatch === 'showcase-timeout') {
      const value = await runUntrusted({
        config: selected.config,
        model: '["deepseek-official","deepseek-v4-flash"]',
        effort: 'high',
        message: 'Return a text answer.',
        images: [],
        providerSettings: {},
        timeoutMs: 900000,
        log: {},
      });

      assert.equal(value.reply, 'loopback-ok');
      assert.equal(value.sessionId, null);
      assert.equal(mock.payloads.length, 1);
      assert.equal((mock.payloads[0]!.tools ?? []).length, 0);

      return;
    }

    const pending = runtime.modelText({
      modelRef: {
        provider: 'deepseek',
        model: '["deepseek-official","deepseek-v4-flash"]',
        effort: 'high'
      },
      message: 'Return a text answer.',
      onReceipt: (receipt) => {
        receipts.push(receipt);
      }
    });

    if (mismatch) {
      await assert.rejects(pending, (error: any) => {
        assert.equal(error.code, 'unsafe_model_provider');
        assert.equal(error.message, 'Не удалось выполнить изолированный вызов модели.');
        assert.equal('sessionId' in error, false);
        assert.equal('steps' in error, false);
        assert.equal('cause' in error, false);
        assert.doesNotMatch(String(error.stack), /PRIVATE_SNAPSHOT_POISON|token=/);

        return true;
      });
      assert.equal(mock.payloads.length, 0);
      assert.equal(receipts.length, 0);

      return;
    }

    const result = await pending;

    assert.equal(result.reply, 'loopback-ok');
    assert.equal(result.cost, null);
    assert.equal(receipts.length, 1);
    assert.equal(mock.payloads.length, 1);
    assert.equal((mock.payloads[0]!.tools ?? []).length, 0);
  });
}

test('DeepSeek model-only: отсутствующий ключ и media не запускают процесс', async () => {
  let started = false;
  const call = async (extra: object) => adapter.runUntrusted
    ? adapter.runUntrusted({
      config: {
        deepseekBin: '/missing'
      },
      model: '["deepseek-official","deepseek-v4-flash"]',
      message: 'x',
      env: {},
      startServer: async () => {
        started = true;

        throw new Error('must not spawn');
      },
      ...extra
    })
    : {
      reply: null
    };

  await assert.rejects(call({}), {
    code: 'deepseek_api_key_missing'
  });
  await assert.rejects(call({
    images: [{}]
  }), {
    code: 'unsupported_media'
  });
  assert.equal(started, false);
});
