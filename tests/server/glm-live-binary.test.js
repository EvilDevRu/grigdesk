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
  const messages = payload.messages.filter((item) => item.role === 'user').map((item) =>
    typeof item.content === 'string' ? item.content
      : (item.content ?? []).map((block) => block.text ?? '').join('\n'));

  return messages.findLast((message) => !message.startsWith('Current runtime context.')) ?? '';
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

    if (message.includes('Запусти foreground критика') && index === 0) {
      return glmToolCall('subagent', {
        description: 'Smoke-критик', prompt: 'GLM_SMOKE_CHILD: прочитай marker.txt и проверь суффикс.',
      }, 'smoke-delegation');
    }
    if (message.includes('GLM_SMOKE_CHILD') && index === 0) {
      return glmToolCall('read', { file_path: 'marker.txt' }, 'smoke-child-read');
    }

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

test('smoke выбирает явный ELF/cache, отчёт loopback и не меняет допуск выпуска', {
  timeout: 900000,
}, async (t) => {
  const candidate = await ensureTestDeepSeekBinary();
  const binarySha = await sha256File(candidate.binary);
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

  if (!report.ok) {
    t.diagnostic(JSON.stringify(mock.requests.map(({ payload }) => lastUser(payload).slice(0, 80))));
  }

  assert.equal(report.ok, true, JSON.stringify(report.steps));
  assert.equal(report.kind, 'loopback');
  assert.equal(report.mode, 'api');
  assert.equal(report.packageId, candidate.info.packageId);
  assert.equal(report.sha256, binarySha);
  assert.equal(await sha256File(candidate.binary), binarySha);
  assert.match(report.compatibility, /^[a-f0-9]{64}$/u);
  assert.ok(report.turns <= GLM_SMOKE_MAX_TURNS);
  assert.ok(launches.length >= 6);
  assert.ok(launches.every(([binary, args]) => binary === candidate.binary
    && args.includes('--cache-dir') && args.includes(candidate.cacheDir)));
  assert.ok(mock.requests.length > 0);
  assert.ok(mock.requests.every((request) => request.authorizationMatches));
  assert.equal(JSON.stringify(report).includes(GLM_SERVICE_KEY), false);

  const productionDeps = {
    env,
    modelEndpoint: mock.endpoint,
    egressGuard: await writeGlmEgressGuard(root),
  };
  const production = createGlmAdapter(productionDeps);
  const input = {
    config: {
      deepseekRuntimeMode: 'binary',
      deepseekBin: candidate.binary,
      deepseekCacheDir: candidate.cacheDir,
      glmRuntimeHome: path.join(root, 'production-home'),
    },
    cwd: root,
    chatKey: 'production-admission',
    model: '["zai","glm-5.3"]',
    message: 'Проверка production admission через loopback',
    signal: AbortSignal.timeout(60000),
    onSessionCreated: async () => {},
  };

  const after = await ensureTestDeepSeekBinary();

  assert.deepEqual(after.info.glm.admission, candidate.info.glm.admission,
    'smoke не выдаёт постоянный допуск до проверки отчёта');

  if (candidate.info.glm.admission.some((entry) => entry.mode === 'api'
    && entry.compatibility === report.compatibility)) {
    assert.equal((await production.run(input)).reply, 'готово');
  } else {
    const before = mock.requests.length;

    await assert.rejects(production.run(input), { code: 'glm_runtime_not_admitted' });
    assert.equal(mock.requests.length, before, 'временный smoke admission не открыл production');
  }

  const requests = mock.requests.length;
  const denied = createGlmAdapter({
    ...productionDeps,
    admission: [{ mode: 'api', compatibility: '0'.repeat(64) }],
    spawn: () => assert.fail('Несовместимый admission обязан отказать до процесса'),
  });

  await assert.rejects(denied.run({
    ...input,
    chatKey: 'incompatible-admission',
  }), { code: 'glm_runtime_not_admitted' });
  assert.equal(mock.requests.length, requests);
});

test('smoke отвергает неизвестный режим до файловой системы и DI admission', async () => {
  await assert.rejects(runGlmLiveSmoke({
    mode: 'unknown',
    env: {},
    config: serviceConfig,
    binary: '/missing',
    cacheDir: '/missing',
    workRoot: '/missing',
  }), { code: 'glm_mode_not_admitted' });
});

test('оба режима smoke проверяют абсолютные пути до чтения env и ELF', async () => {
  for (const mode of ['api', 'coding-plan']) {
    await assert.rejects(runGlmLiveSmoke({
      mode,
      env: {},
      config: serviceConfig,
      binary: 'relative',
      cacheDir: '/missing',
      workRoot: '/missing',
    }), { name: 'TypeError', message: 'Smoke требует абсолютные --binary и --cache-dir' });
  }
});

test('smoke сохраняет HTTP-статус и тело 1113 из настоящего ELF и останавливается на первом отказе', {
  timeout: 900000,
}, async (t) => {
  const candidate = await ensureTestDeepSeekBinary();
  const root = await createGlmBinaryFixtureRoot('glm-live-error-');
  const mock = await startGlmLoopback({
    expectedKey: GLM_SERVICE_KEY,
    scenarios: [{
      kind: 'http-error',
      status: 429,
      code: '1113',
      message: 'Insufficient balance or no resource package. Please recharge.',
    }],
  });

  t.after(async () => {
    await mock.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  const report = await runGlmLiveSmoke({
    mode: 'api',
    env: { PATH: process.env.PATH, ZAI_API_KEY: GLM_SERVICE_KEY },
    config: serviceConfig,
    binary: candidate.binary,
    cacheDir: candidate.cacheDir,
    workRoot: root,
    adapterDeps: {
      modelEndpoint: mock.endpoint,
      egressGuard: await writeGlmEgressGuard(root),
    },
  });

  assert.equal(report.kind, 'loopback');
  assert.equal(report.ok, false);
  assert.equal(report.turns, 1);
  assert.match(report.steps.find((step) => step.name === 'ответ').detail, /код 1113/u);
  assert.equal(report.modelErrors.length, 1);
  assert.equal(report.modelErrors[0].httpStatus, 429);
  assert.equal(JSON.parse(report.modelErrors[0].errorText).error.code, '1113');
  assert.equal(mock.requests.length, 1, 'Терминальный отказ не расходует оставшиеся ходы smoke');
  assert.equal(JSON.stringify(report).includes(GLM_SERVICE_KEY), false);
});

test('CLI с неполными аргументами отказывает до чтения env и запуска модели', async (t) => {
  const root = await createGlmBinaryFixtureRoot('glm-cli-arguments-');

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  for (const args of [
    ['--mode', 'api'],
    ['--mode', 'api', '--confirm-live'],
    ['--mode', 'coding-plan', '--binary', '/missing', '--cache-dir', '/missing'],
    ['--mode', 'coding-plan', '--confirm-live'],
  ]) {
    await assert.rejects(exec(process.execPath, [smokeScript, ...args], {
      env: {
        PATH: process.env.PATH,
        GRIGDESK_HOME: path.join(root, 'data'),
        GRIGDESK_ENV_FILE: path.join(root, 'absent.env'),
        GRIGDESK_ARTIFACTS_DIR: path.join(root, 'artifacts'),
      },
      timeout: 30000,
    }), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--confirm-live/u);
      assert.doesNotMatch(error.stderr, /ENOENT|ZAI_API_KEY/u);

      return true;
    });
  }
});
