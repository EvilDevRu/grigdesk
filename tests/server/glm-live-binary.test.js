import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { runGlmLiveSmoke, GLM_SMOKE_MAX_TURNS } from '../../server/scripts/glmLiveSmoke.mts';
import { config as serviceConfig } from '../../server/src/config.ts';
import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { sha256File } from '../../shared/node/hash.ts';
import { ensureTestDeepSeekBinary } from '../helpers/deepseekBinary.mts';
import { startGlmLoopback } from '../helpers/glmLoopback.mts';
import { createGlmBinaryFixtureRoot, glmBinaryFixture } from '../helpers/glmBinary.mts';
import {
  GLM_SERVICE_KEY,
  glmTextReply,
  glmToolCall,
  writeGlmEgressGuard,
} from '../helpers/glmProductionFixture.mts';

const exec = promisify(execFile);
const smokeScript = fileURLToPath(new URL('../../server/scripts/glmLiveSmoke.mts', import.meta.url));

test('GLM передаёт approval человеку после resume настоящей сессии', { timeout: 900000 }, async (t) => {
  let target;
  let asked = 0;
  const f = await glmBinaryFixture(t, { respond: (_payload, index) => index === 1
    ? glmToolCall('write', {
      file_path: target,
      content: 'late',
      sandbox_permissions: 'danger-full-access',
      justification: 'resume approval',
    }) : glmTextReply() });

  target = path.join(f.root, 'outside.txt');

  const first = await f.run();
  const second = await f.run({
    sessionId: first.sessionId,
    onPermission: async () => {
      asked += 1;

      return { allow: false };
    },
  });

  assert.equal(second.sessionId, first.sessionId);
  assert.equal(asked, 1);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

/**
 * Последняя реплика пользователя определяет текущий шаг фиксированного smoke-сценария.
 * Содержимое ответов инструментов остаётся в реальном журнале Harness и HTTP payload.
 */
function lastUser(payload) {
  const message = payload.messages.filter((item) => item.role === 'user').at(-1);

  return typeof message?.content === 'string' ? message.content
    : (message?.content ?? []).map((item) => item.text ?? '').join('\n');
}

/**
 * Детерминированная модель выполняет сценарий инструмента через настоящий ELF.
 * Подмена ограничена loopback HTTP: чтение, запись, bash и approval делает Harness.
 */
function smokeModel() {
  const calls = new Map();
  let marker;

  return (payload) => {
    const message = lastUser(payload);
    const index = calls.get(message) ?? 0;

    calls.set(message, index + 1);

    if (message.includes('Прочитай marker.txt')) {
      marker ??= /GLM-SMOKE-[a-f0-9]+/u.exec(JSON.stringify(payload.messages))?.[0];

      if (index === 0) {
        return glmToolCall('read', { file_path: 'marker.txt' }, 'smoke-read');
      }
      if (index === 1) {
        assert.ok(marker, 'Маркер прочитан настоящим инструментом');

        return glmToolCall('write', {
          file_path: 'marker.txt',
          content: `${marker}-EDITED\n`,
        }, 'smoke-write');
      }
      if (index === 2) {
        return glmToolCall('bash', {
          command: 'wc -c marker.txt',
          description: 'smoke-count',
        }, 'smoke-count');
      }

      return {
        kind: 'stream',
        deltas: [{ role: 'assistant', reasoning_content: 'Файл прочитан и изменён.' }, { content: 'готово' }],
      };
    }
    if (message.includes('Какой маркер')) {
      return glmTextReply(marker);
    }
    if (message.includes('ssh -p 9') && index === 0) {
      return glmToolCall('bash', {
        command: 'ssh -p 9 smoke@127.0.0.1 true',
        description: 'ssh',
      }, 'smoke-ssh');
    }
    if (message.includes('Запиши файл outside.txt') && index === 0) {
      const target = /Путь: ([^\r\n]+)/u.exec(message)?.[1];

      assert.ok(target);

      return glmToolCall('write', {
        file_path: target,
        content: 'late',
        sandbox_permissions: 'danger-full-access',
        justification: 'smoke approval',
      }, 'smoke-outside');
    }

    return glmTextReply('готово');
  };
}

test('smoke выбирает явный ELF/cache, отчёт loopback и временный api admission', {
  timeout: 900000,
}, async (t) => {
  const candidate = await ensureTestDeepSeekBinary();
  const root = await createGlmBinaryFixtureRoot('glm-live-binary-');
  const mock = await startGlmLoopback({ expectedKey: GLM_SERVICE_KEY, respond: smokeModel() });
  const env = {
    PATH: process.env.PATH,
    GRIGDESK_GLM_API_MODE: 'api',
    ZAI_API_KEY: GLM_SERVICE_KEY,
  };
  const launches = [];

  t.after(async () => {
    await mock.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  const report = await runGlmLiveSmoke({
    mode: 'api',
    env,
    binary: candidate.binary,
    cacheDir: candidate.cacheDir,
    workRoot: root,
    config: {
      ...serviceConfig,
      deepseekRuntimeMode: 'embedded',
      deepseekArtifactDir: path.join(root, 'missing-legacy'),
      deepseekBinOverride: path.join(root, 'missing-service-override'),
    },
    adapterDeps: {
      modelEndpoint: mock.endpoint,
      egressGuard: await writeGlmEgressGuard(root),
      spawn: (...args) => {
        launches.push(args);

        return spawn(...args);
      },
    },
  });

  assert.equal(report.ok, true, JSON.stringify(report.steps));
  assert.equal(report.kind, 'loopback');
  assert.equal(report.mode, 'api');
  assert.equal(report.packageId, candidate.info.packageId);
  assert.equal(report.sha256, await sha256File(candidate.binary));
  assert.match(report.compatibility, /^[a-f0-9]{64}$/u);
  assert.ok(report.turns <= GLM_SMOKE_MAX_TURNS);
  assert.ok(launches.length >= 6);
  assert.ok(launches.every(([binary, args]) => binary === candidate.binary
    && args.includes('--cache-dir') && args.includes(candidate.cacheDir)));
  assert.ok(mock.requests.length > 0);
  assert.ok(mock.requests.every((request) => request.authorizationMatches));
  assert.equal(JSON.stringify(report).includes(GLM_SERVICE_KEY), false);

  const production = createGlmAdapter({ env });

  await assert.rejects(production.run({
    config: {
      deepseekRuntimeMode: 'binary',
      deepseekBin: candidate.binary,
      deepseekCacheDir: candidate.cacheDir,
      glmRuntimeHome: path.join(root, 'production-home'),
    },
    cwd: root,
    chatKey: 'production-still-denied',
    model: '["zai","glm-5.3"]',
    message: 'Не отправлять',
    onSessionCreated: async () => {},
  }), { code: 'glm_runtime_not_admitted' });
});

test('smoke не выдаёт DI admission для Coding Plan', async () => {
  await assert.rejects(runGlmLiveSmoke({
    mode: 'coding-plan',
    env: {},
    config: serviceConfig,
    binary: '/missing',
    cacheDir: '/missing',
    workRoot: '/missing',
  }), { code: 'glm_mode_not_admitted' });
});

test('CLI без confirm-live отказывает до чтения env и запуска модели', async () => {
  for (const args of [
    ['--mode', 'api'],
    ['--mode', 'api', '--confirm-live'],
    ['--mode', 'coding-plan', '--confirm-live', '--binary', '/missing', '--cache-dir', '/missing'],
  ]) {
    await assert.rejects(exec(process.execPath, [smokeScript, ...args], {
      env: { PATH: process.env.PATH, GRIGDESK_DATA_HOME: '/missing-smoke-env' },
      timeout: 30000,
    }), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--confirm-live/u);
      assert.doesNotMatch(error.stderr, /ENOENT|ZAI_API_KEY/u);

      return true;
    });
  }
});
