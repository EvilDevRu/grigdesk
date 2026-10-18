import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Analyzer } from '../../server/src/lib/analysis/analyzer.ts';

const RESULT = {
  task: 42,
  project: 'Demo',
  route_guess: 'feature',
  complexity: 3,
  risk: 2,
  diff_size: 'M',
  areas: ['BE'],
  files: [],
  risk_markers: [],
  unknowns: [],
  questions: [],
  needs_clarification: false,
  confidence: 'high',
  summary: 'Проверка раннера.',
};

/**
 * Модель в тесте пишет те же два server-owned файла, что и настоящий trusted run.
 * Путь извлекается из публичного prompt-контракта, поэтому staging остаётся во власти Analyzer.
 */
async function writeRunFiles(options) {
  const prompt = String(options.message || options.prompt || '');
  const jsonPath = prompt.match(/(?:- |\[Схема )([^\s\]]+\.analysis\.json)/)?.[1];
  const task = Number(path.basename(jsonPath || '').match(/^t(\d+)/)?.[1] || RESULT.task);
  const notePath = prompt.match(/- ([^\s]+\/t\d+\.md)/)?.[1];
  if (!jsonPath) throw new Error('в prompt нет server-owned analysis path');
  await mkdir(path.dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify({ ...RESULT, task }));
  if (notePath) await writeFile(notePath, '# Разведка\n');
}

function runnerConfig(root, extra = {}) {
  return {
    analysisDir: path.join(root, 'analysis'),
    analysisModel: 'legacy-model',
    claudeBin: path.join(root, 'legacy-claude'),
    chatsDir: path.join(root, 'chats'),
    factoryHome: root,
    profilesDir: path.join(root, 'profiles'),
    factoryProfile: '',
    analysisTimeoutMs: 1000,
    analysisConcurrency: 1,
    ...extra,
  };
}

function runnerDeps(overrides = {}) {
  return {
    claudeAuth: { env: () => process.env },
    b24: {
      async taskDetail() { return { title: 'Demo | задача', description: '' }; },
      async taskPageData() { return { comments: [] }; },
    },
    factoryState: {
      async primaryProfile() { return null; },
    },
    prefs: { read: () => ({}) },
    log: null,
    pluginEnabled: () => true,
    pluginSettings: () => ({
      triageModel: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
      autoArbitrate: false,
    }),
    providerRegistry: async () => ({
      codex: [{ id: 'gpt-5.6-sol', efforts: ['low', 'high'] }],
    }),
    ...overrides,
  };
}

async function exists(file) {
  return stat(file).then(() => true, () => false);
}

test('каждый запуск берёт выбранные provider/model/effort и пишет фактическую meta', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'analysis-runner-'));
  const analysisDir = path.join(root, 'analysis');
  const legacyBin = path.join(root, 'legacy-claude');
  const legacyJson = path.join(analysisDir, 't42.analysis.json');
  await mkdir(analysisDir);
  await writeFile(legacyBin, [
    '#!/bin/sh',
    'printf \'%s\' "$GRIGDESK_TEST_ANALYSIS" > "$GRIGDESK_TEST_ANALYSIS_JSON"',
    'printf \'%s\\n\' \'{"result":"legacy","total_cost_usd":0.01}\'',
  ].join('\n'));
  await chmod(legacyBin, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));

  const calls = [];
  const executor = {
    id: 'codex',
    scopedWorkspace: true,
    async run(options) {
      calls.push({
        model: options.model,
        effort: options.effort,
        workspaceAccess: options.workspaceAccess,
      });
      await writeRunFiles(options);
      return {
        reply: 'ok',
        actualModel: 'gpt-5.6-sol-2026-08',
        cost: 0.12,
        contextTokens: 321,
      };
    },
  };
  const registry = {
    codex: [{
      id: 'gpt-5.6-sol',
      efforts: ['low', 'high'],
    }],
  };
  const analyzer = new Analyzer({
    config: {
      analysisDir,
      analysisModel: 'hardcoded-claude',
      claudeBin: legacyBin,
      chatsDir: path.join(root, 'chats'),
      factoryHome: root,
      profilesDir: path.join(root, 'profiles'),
      factoryProfile: '',
      analysisTimeoutMs: 1000,
      analysisConcurrency: 1,
    },
    claudeAuth: {
      env: () => ({
        ...process.env,
        GRIGDESK_TEST_ANALYSIS: JSON.stringify(RESULT),
        GRIGDESK_TEST_ANALYSIS_JSON: legacyJson,
      }),
    },
    b24: {
      async taskDetail() { return { title: 'Demo | задача', description: '' }; },
      async taskPageData() { return { comments: [] }; },
    },
    factoryState: {
      async primaryProfile() { return null; },
    },
    prefs: { read: () => ({}) },
    log: null,
    pluginEnabled: () => true,
    pluginSettings: () => ({
      triageModel: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
      autoArbitrate: false,
    }),
    providerRegistry: async () => registry,
    executorFor: async (provider) => (provider === 'codex' ? executor : null),
  });
  await analyzer._ready;

  const run = await analyzer.analyze('42');
  const saved = JSON.parse(await readFile(legacyJson, 'utf8'));
  const access = calls[0]?.workspaceAccess;

  assert.deepEqual({
    ok: run.ok,
    call: {
      count: calls.length,
      model: calls[0]?.model,
      effort: calls[0]?.effort,
      writableCount: access?.writableRoots?.length,
      writableInsideAnalysis: access?.writableRoots?.every((entry) => (
        path.relative(analysisDir, entry) && !path.relative(analysisDir, entry).startsWith('..')
      )),
      networkAccess: access?.networkAccess,
      allowExternalMcp: access?.allowExternalMcp,
      allowBash: access?.allowBash,
      tools: access?.tools,
    },
    meta: {
      provider: saved.meta?.provider,
      model: saved.meta?.model,
      effort: saved.meta?.effort,
    },
  }, {
    ok: true,
    call: {
      count: 1,
      model: 'gpt-5.6-sol',
      effort: 'high',
      writableCount: 1,
      writableInsideAnalysis: true,
      networkAccess: false,
      allowExternalMcp: false,
      allowBash: false,
      tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'repo_history'],
    },
    meta: {
      provider: 'codex',
      model: 'gpt-5.6-sol-2026-08',
      effort: 'high',
    },
  });
});

test('пустая настройка модели завершает триаж typed-ошибкой без legacy fallback', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'analysis-runner-unset-'));
  await mkdir(path.join(root, 'analysis'));
  const legacyMarker = path.join(root, 'legacy-called');
  const legacyBin = path.join(root, 'legacy-claude');
  await writeFile(legacyBin, `#!/bin/sh\nprintf called > ${JSON.stringify(legacyMarker)}\n`);
  await chmod(legacyBin, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const analyzer = new Analyzer({
    config: runnerConfig(root),
    ...runnerDeps({
      pluginSettings: () => ({ triageModel: null, autoArbitrate: false }),
      executorFor: async () => ({
        id: 'codex',
        scopedWorkspace: true,
        async run(options) {
          calls.push(options);
          await writeRunFiles(options);
          return { reply: 'ok' };
        },
      }),
    }),
  });
  await analyzer._ready;

  const result = await analyzer.analyze('42');

  assert.deepEqual({
    result,
    executorCalls: calls.length,
    legacyCalled: await exists(legacyMarker),
  }, {
    result: { ok: false, error: 'analysis_model_unset' },
    executorCalls: 0,
    legacyCalled: false,
  });
});

test('исчезнувшая модель обнаруживается по свежему реестру перед повторным запуском', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'analysis-runner-live-registry-'));
  await mkdir(path.join(root, 'analysis'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let registry = { codex: [{ id: 'gpt-5.6-sol', efforts: ['high'] }] };
  let registryReads = 0;
  const calls = [];
  const executor = {
    id: 'codex',
    scopedWorkspace: true,
    async run(options) {
      calls.push(options.model);
      await writeRunFiles(options);
      return { reply: 'ok', actualModel: options.model };
    },
  };
  const analyzer = new Analyzer({
    config: runnerConfig(root),
    ...runnerDeps({
      providerRegistry: async () => {
        registryReads += 1;
        return registry;
      },
      executorFor: async () => executor,
    }),
  });
  await analyzer._ready;

  const first = await analyzer.analyze('42');
  const snapshot = await readFile(
    path.join(root, 'analysis', 't42.analysis.json'),
    'utf8',
  ).catch(() => null);
  registry = { codex: [] };
  const second = await analyzer.analyze('42');

  assert.deepEqual({
    first,
    second,
    registryReads,
    executorCalls: calls,
    snapshotPreserved: snapshot !== null && await readFile(
      path.join(root, 'analysis', 't42.analysis.json'),
      'utf8',
    ).then((value) => value === snapshot, () => false),
  }, {
    first: { ok: true },
    second: { ok: false, error: 'analysis_model_unavailable' },
    registryReads: 2,
    executorCalls: ['gpt-5.6-sol'],
    snapshotPreserved: true,
  });
});

test('смена настройки и живого реестра действует уже на следующем запуске', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'analysis-runner-live-setting-'));
  await mkdir(path.join(root, 'analysis'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let selected = { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' };
  let registry = {
    claude: [{ id: 'claude-sonnet-5', efforts: ['low'] }],
    codex: [{ id: 'gpt-5.6-sol', efforts: ['high'] }],
  };
  const calls = [];
  const executors = Object.fromEntries(['claude', 'codex'].map((provider) => [provider, {
    id: provider,
    scopedWorkspace: true,
    async run(options) {
      calls.push([provider, options.model, options.effort]);
      await writeRunFiles(options);
      return { reply: 'ok', actualModel: options.model };
    },
  }]));
  const analyzer = new Analyzer({
    config: runnerConfig(root),
    ...runnerDeps({
      pluginSettings: () => ({ triageModel: selected, autoArbitrate: false }),
      providerRegistry: async () => registry,
      executorFor: async (provider) => executors[provider],
    }),
  });
  await analyzer._ready;

  const first = await analyzer.analyze('42');
  selected = { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' };
  registry = { codex: [{ id: 'gpt-5.6-sol', efforts: ['high'] }] };
  const second = await analyzer.analyze('43');

  assert.deepEqual({ first, second, calls }, {
    first: { ok: true },
    second: { ok: true },
    calls: [
      ['claude', 'claude-sonnet-5', 'low'],
      ['codex', 'gpt-5.6-sol', 'high'],
    ],
  });
});

test('исчезнувший effort снимается с предупреждением, но не подменяет модель', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'analysis-runner-stale-effort-'));
  await mkdir(path.join(root, 'analysis'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const executor = {
    id: 'codex',
    scopedWorkspace: true,
    async run(options) {
      calls.push(options);
      await writeRunFiles(options);
      return { reply: 'ok', actualModel: options.model };
    },
  };
  const analyzer = new Analyzer({
    config: runnerConfig(root),
    ...runnerDeps({
      providerRegistry: async () => ({
        codex: [{ id: 'gpt-5.6-sol', efforts: ['low'] }],
      }),
      executorFor: async () => executor,
    }),
  });
  await analyzer._ready;

  const result = await analyzer.analyze('42');
  const saved = await readFile(
    path.join(root, 'analysis', 't42.analysis.json'),
    'utf8',
  ).then((value) => JSON.parse(value), () => ({}));

  assert.deepEqual({
    result,
    run: [calls[0]?.model, calls[0]?.effort],
    meta: [saved.meta?.model, saved.meta?.effort],
    warning: saved.meta?.warning || saved.meta?.warnings,
  }, {
    result: { ok: true },
    run: ['gpt-5.6-sol', null],
    meta: ['gpt-5.6-sol', null],
    warning: 'analysis_effort_unavailable',
  });
});

test('адаптер без scopedWorkspace отклоняется до запуска модели', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'analysis-runner-unsafe-'));
  await mkdir(path.join(root, 'analysis'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const analyzer = new Analyzer({
    config: runnerConfig(root),
    ...runnerDeps({
      executorFor: async () => ({
        id: 'fake',
        async scopedWorkspace() { return false; },
        async run(options) { calls.push(options); },
      }),
    }),
  });
  await analyzer._ready;

  const result = await analyzer.analyze('42');

  assert.deepEqual({ result, executorCalls: calls.length }, {
    result: { ok: false, error: 'analysis_model_unsafe' },
    executorCalls: 0,
  });
});

test('раннер открывает на чтение cwd, dirs, repos и input, но пишет только в output', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'analysis-runner-roots-'));
  const analysisDir = path.join(root, 'analysis');
  const profileDir = path.join(root, 'profiles', 'demo');
  const cwd = path.join(root, 'profile-cwd');
  const extraA = path.join(root, 'extra-a');
  const extraB = path.join(root, 'extra-b');
  const repo = path.join(root, 'repo-be');
  await Promise.all([
    mkdir(analysisDir),
    mkdir(profileDir, { recursive: true }),
    mkdir(cwd),
    mkdir(extraA),
    mkdir(extraB),
    mkdir(repo),
  ]);
  await writeFile(path.join(profileDir, 'profile.sh'), [
    `PROFILE_AGENT_CWD=${JSON.stringify(cwd)}`,
    `PROFILE_AGENT_DIRS=${JSON.stringify(`${cwd} ${extraA} ${extraB}`)}`,
    `PROFILE_TRIAGE_REPOS=${JSON.stringify(`be:${repo}`)}`,
  ].join('\n'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const executor = {
    id: 'codex',
    scopedWorkspace: true,
    async run(options) {
      calls.push(options.workspaceAccess);
      await writeRunFiles(options);
      return { reply: 'ok', actualModel: options.model };
    },
  };
  const analyzer = new Analyzer({
    config: runnerConfig(root, { factoryProfile: 'demo' }),
    ...runnerDeps({
      factoryState: { async primaryProfile() { return 'demo'; } },
      executorFor: async () => executor,
    }),
  });
  await analyzer._ready;

  const result = await analyzer.analyze('42');
  const access = calls[0] || {};
  const readable = new Set(access.readableRoots || []);
  const writable = access.writableRoots || [];
  const inputRoots = [...readable].filter((entry) => (
    entry !== analysisDir
    && !path.relative(analysisDir, entry).startsWith('..')
  ));

  assert.deepEqual({
    result,
    protectedReadable: [cwd, extraA, extraB, repo].every((entry) => readable.has(entry)),
    duplicateCwdCount: (access.readableRoots || []).filter((entry) => entry === cwd).length,
    inputCount: inputRoots.length,
    inputWritable: inputRoots.some((entry) => writable.includes(entry)),
    writableCount: writable.length,
    writableInsideAnalysis: writable.every((entry) => (
      path.relative(analysisDir, entry) && !path.relative(analysisDir, entry).startsWith('..')
    )),
  }, {
    result: { ok: true },
    protectedReadable: true,
    duplicateCwdCount: 1,
    inputCount: 1,
    inputWritable: false,
    writableCount: 1,
    writableInsideAnalysis: true,
  });
});
