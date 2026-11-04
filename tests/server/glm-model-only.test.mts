import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { createPluginRuntimeServices } from '../../server/src/modules/plugins/runtimeServices.ts';
import { describeGlmGenerationAsync } from '../../server/src/lib/glm/generation.ts';
import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';
import { ensureGlmTestRuntime } from '../helpers/glmTestRuntime.mts';
import { startGlmLoopback } from '../helpers/glmLoopback.mts';
import { writeGlmEgressGuard } from '../helpers/glmEgressGuard.mts';

for (const transport of ['core', 'showcase-timeout']) {
  for (const mode of ['api', 'coding-plan'] as const) {
    test(`CORE-MODEL/GLM: ${transport}/${mode}, свой ключ, пустые tools, receipt`, async (t) => {
      const selected = await ensureGlmTestRuntime();
      const generation = await describeGlmGenerationAsync(selected.config);
      const identity = glmCompatibilityIdentity(generation.runtime, mode);
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-model-only-'));
      const key = mode === 'api' ? 'synthetic-api' : 'synthetic-coding';
      const mock = await startGlmLoopback({
        expectedKey: key,
        prefix: mode === 'api' ? '/api/paas/v4' : '/api/coding/paas/v4',
        respond: async () => ({
          kind: 'stream',
          deltas: [{
            role: 'assistant',
            content: 'glm-ok'
          }]
        })
      });

      t.after(async () => {
        await mock.stop();
        await fs.rm(root, {
          recursive: true,
          force: true
        });
      });

      const adapter = createGlmAdapter({
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GRIGDESK_GLM_API_MODE: mode,
          ZAI_API_KEY: 'synthetic-api',
          ZAI_CODING_API_KEY: 'synthetic-coding',
          DEEPSEEK_API_KEY: 'foreign-key'
        },
        admission: [{
          mode,
          compatibility: identity
        }],
        catalog: [{
          id: '["zai","glm-5.3"]',
          efforts: ['high']
        }],
        modelEndpoint: mock.endpoint,
        egressGuard: await writeGlmEgressGuard(root),
      }) as unknown as Record<string, any>;

      assert.equal(adapter.untrustedInput?.text, true);
      assert.equal(adapter.untrustedInput?.images, false);

      const receipts: unknown[] = [];
      const core = createPluginRuntimeServices({
        config: selected.config,
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
            provider: 'glm',
            model: '["zai","glm-5.3"]'
          },
          effort: 'high',
          executor: {
            untrustedInput: adapter.untrustedInput,
            runUntrusted: (input: any) => adapter.runUntrusted(input)
          }
        }),
      });

      if (transport === 'showcase-timeout') {
        const value = await adapter.runUntrusted({
          config: selected.config,
          model: '["zai","glm-5.3"]',
          effort: 'high',
          message: 'Return a text answer.',
          images: [],
          providerSettings: {},
          timeoutMs: 900000,
          log: {},
        });

        assert.equal(value.reply, 'glm-ok');
        assert.equal(value.sessionId, null);
        assert.equal(mock.requests.length, 1);
        mock.assertComplete();

        return;
      }

      const result = await core.modelText({
        modelRef: {
          provider: 'glm',
          model: '["zai","glm-5.3"]',
          effort: 'high'
        },
        message: 'Return text.',
        onReceipt: (receipt) => {
          receipts.push(receipt);
        }
      });

      assert.equal(result.reply, 'glm-ok');
      assert.equal(result.cost, null);
      assert.equal(receipts.length, 1);
      assert.equal(mock.requests.length, 1);
      assert.equal(mock.requests[0]!.authorizationMatches, true);
      assert.equal(((mock.requests[0]!.payload.tools ?? []) as unknown[]).length, 0);
      assert.doesNotMatch(JSON.stringify(result), /synthetic-|foreign-key/);
    });
  }
}

test('GLM model-only: setup-only не объявляет capability', () => {
  const setup = createGlmAdapter({
    env: {}
  }) as unknown as Record<string, any>;

  assert.equal(setup.runUntrusted, undefined);
  assert.equal(setup.untrustedInput, undefined);
});
test('GLM model-only: wrong identity не запускает процесс и не делает fallback ключа', async (t) => {
  const selected = await ensureGlmTestRuntime();
  const adapter = createGlmAdapter({
    env: {
      GRIGDESK_GLM_API_MODE: 'api',
      ZAI_API_KEY: 'synthetic'
    },
    admission: [{
      mode: 'api',
      compatibility: '0'.repeat(64)
    }],
    spawn: () => {
      throw new Error('must not spawn');
    },
  }) as unknown as Record<string, any>;
  const call = async () => adapter.runUntrusted
    ? adapter.runUntrusted({
      config: selected.config,
      model: '["zai","glm-5.3"]',
      message: 'x'
    }) : {
      reply: null
    };

  await assert.rejects(call(), {
    code: 'glm_runtime_not_admitted'
  });
});

for (const mode of ['api', 'coding-plan'] as const) {
  for (const finishReason of ['length', 'tool_calls', 'http-error', 'auth-error', 'disconnect']) {
    test(`CORE-MODEL/GLM: ${mode}, ${finishReason}, только отказ и один запрос`, async (t) => {
      const selected = await ensureGlmTestRuntime();
      const generation = await describeGlmGenerationAsync(selected.config);
      const identity = glmCompatibilityIdentity(generation.runtime, mode);
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-model-partial-'));
      const key = mode === 'api' ? 'synthetic-api' : 'synthetic-coding';
      const mock = await startGlmLoopback({
        expectedKey: key,
        prefix: mode === 'api' ? '/api/paas/v4' : '/api/coding/paas/v4',
        respond: async () => {
          if (finishReason === 'http-error' || finishReason === 'auth-error') {
            return {
              kind: 'http-error',
              status: finishReason === 'auth-error' ? 401 : 503,
              code: 'SYNTHETIC_PRIVATE_CODE',
              message: 'SYNTHETIC_PRIVATE_ERROR',
            };
          }

          if (finishReason === 'disconnect') {
            return {
              kind: 'disconnect',
              deltas: [{ content: 'partial-text' }],
            };
          }

          return {
            kind: 'stream',
            deltas: [{
              role: 'assistant',
              content: 'partial-text',
            }],
            finishReason,
          };
        },
      });

      t.after(async () => {
        await mock.stop();
        await fs.rm(root, {
          recursive: true,
          force: true
        });
      });

      const adapter = createGlmAdapter({
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GRIGDESK_GLM_API_MODE: mode,
          ZAI_API_KEY: 'synthetic-api',
          ZAI_CODING_API_KEY: 'synthetic-coding'
        },
        admission: [{
          mode,
          compatibility: identity
        }],
        catalog: [{
          id: '["zai","glm-5.3"]',
          efforts: ['high']
        }],
        modelEndpoint: mock.endpoint,
        egressGuard: await writeGlmEgressGuard(root),
      }) as unknown as Record<string, any>;
      const core = createPluginRuntimeServices({
        config: selected.config,
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
            provider: 'glm',
            model: '["zai","glm-5.3"]'
          },
          effort: 'high',
          executor: {
            untrustedInput: adapter.untrustedInput,
            runUntrusted: (input: any) => adapter.runUntrusted?.(input)
          }
        }),
      });

      await assert.rejects(core.modelText({
        modelRef: {
          provider: 'glm',
          model: '["zai","glm-5.3"]',
          effort: 'high'
        },
        message: 'Return a text answer.',
      }), (error: any) => {
        assert.equal(error.code, 'model_run_failed');
        assert.equal(error.message, 'Не удалось выполнить изолированный вызов модели.');
        assert.equal('sessionId' in error, false);
        assert.equal('steps' in error, false);
        assert.equal('cause' in error, false);
        assert.doesNotMatch(String(error.stack), /SYNTHETIC_PRIVATE|synthetic-api|synthetic-coding/);

        return true;
      });
      assert.equal(mock.requests.length, 1);
      mock.assertComplete();
    });
  }
}

for (const mode of ['api', 'coding-plan'] as const) {
  test(`GLM model-only: ${mode}, нет fallback ключа и preflight до runtime`, async () => {
    let spawned = false;
    const deps = {
      admission: [{ mode, compatibility: '0'.repeat(64) }],
      catalog: [{ id: '["zai","glm-5.3"]', efforts: ['high'] }],
      spawn: () => {
        spawned = true;

        throw new Error('Процесс не должен запускаться');
      },
    };
    const missingKey = createGlmAdapter({
      ...deps,
      env: {
        GRIGDESK_GLM_API_MODE: mode,
        ...(mode === 'api' ? { ZAI_CODING_API_KEY: 'foreign-key' } : { ZAI_API_KEY: 'foreign-key' }),
      },
    }) as any;
    const allowed = createGlmAdapter({
      ...deps,
      env: {
        GRIGDESK_GLM_API_MODE: mode,
        ZAI_API_KEY: 'synthetic-api',
        ZAI_CODING_API_KEY: 'synthetic-coding',
      },
    }) as any;
    const input = {
      config: { deepseekBin: '/missing' },
      model: '["zai","glm-5.3"]',
      message: 'Return text.',
    };

    await assert.rejects(missingKey.runUntrusted(input), { code: 'glm_key_missing' });
    await assert.rejects(allowed.runUntrusted({ ...input, images: {} }), { code: 'unsupported_media' });
    await assert.rejects(allowed.runUntrusted({
      ...input,
      model: '["other","model"]',
    }), { code: 'glm_model_mismatch' });
    await assert.rejects(allowed.runUntrusted({ ...input, effort: 'low' }), { code: 'glm_effort_mismatch' });
    assert.equal(spawned, false);
  });
}
