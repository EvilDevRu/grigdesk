import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Analyzer } from '../../server/src/lib/analysis/analyzer.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG_URL = pathToFileURL(path.join(ROOT, 'server/src/config.ts')).href;

function memoryPrefs(initial = {}) {
  let stored = structuredClone(initial);
  return {
    readStored: () => structuredClone(stored),
    read: () => structuredClone(stored),
    write(patch) {
      stored = { ...stored, ...structuredClone(patch) };
      return this.read();
    },
  };
}

/** Поднимает изолированный startup-контракт без чтения боевого prefs или вызова модели. */
async function migrationAnalyzer(t, { initial = {}, legacy = 'sonnet' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'analysis-model-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefs = memoryPrefs(initial);
  const previous = process.env.GRIGDESK_ANALYSIS_MODEL;
  process.env.GRIGDESK_ANALYSIS_MODEL = legacy;
  t.after(() => {
    if (previous === undefined) delete process.env.GRIGDESK_ANALYSIS_MODEL;
    else process.env.GRIGDESK_ANALYSIS_MODEL = previous;
  });
  const analyzer = new Analyzer({
    config: {
      analysisDir: path.join(root, 'analysis'),
      chatsDir: path.join(root, 'chats'),
      factoryHome: root,
      profilesDir: path.join(root, 'profiles'),
      factoryProfile: '',
      analysisTimeoutMs: 1000,
      analysisConcurrency: 1,
    },
    claudeAuth: null,
    b24: {
      async taskDetail() { return { title: 'Задача', description: '' }; },
      async taskPageData() { return { comments: [] }; },
    },
    factoryState: { async primaryProfile() { return null; } },
    prefs,
    log: null,
    pluginEnabled: () => true,
    pluginSettings: () => prefs.read().pluginSettings?.analysis || {
      triageModel: null,
      autoArbitrate: false,
    },
    providerRegistry: async () => ({
      claude: [{ id: 'claude-sonnet-5', aliases: ['sonnet'], efforts: ['high'] }],
    }),
    executorFor: async () => null,
  });

  return { analyzer, prefs };
}

async function startAnalyzer(analyzer) {
  if (typeof analyzer.start === 'function') return analyzer.start();
  return { ok: false, error: 'analysis_start_not_implemented' };
}

test('legacy env не остаётся второй runtime-настройкой модели триажа', async () => {
  const saved = process.env.GRIGDESK_ANALYSIS_MODEL;
  process.env.GRIGDESK_ANALYSIS_MODEL = 'legacy-sonnet';
  try {
    const { config } = await import(`${CONFIG_URL}?analysis-model-migration=${Date.now()}`);

    assert.equal(Object.hasOwn(config, 'analysisModel'), false);
  } finally {
    if (saved === undefined) delete process.env.GRIGDESK_ANALYSIS_MODEL;
    else process.env.GRIGDESK_ANALYSIS_MODEL = saved;
  }
});

test('пустые prefs один раз получают точную Claude-модель из legacy env', async (t) => {
  const { analyzer, prefs } = await migrationAnalyzer(t);

  await startAnalyzer(analyzer);

  assert.deepEqual(prefs.readStored().pluginSettings?.analysis?.triageModel, {
    provider: 'claude',
    model: 'claude-sonnet-5',
  });
});

test('сохранённые модель и null имеют приоритет над legacy env', async (t) => {
  const selected = { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' };
  const valueFixture = await migrationAnalyzer(t, {
    initial: { pluginSettings: { analysis: { triageModel: selected } } },
    legacy: 'sonnet',
  });
  const nullFixture = await migrationAnalyzer(t, {
    initial: { pluginSettings: { analysis: { triageModel: null } } },
    legacy: 'sonnet',
  });

  const valueStarted = await startAnalyzer(valueFixture.analyzer);
  const nullStarted = await startAnalyzer(nullFixture.analyzer);

  assert.deepEqual({
    lifecycle: [valueStarted, nullStarted]
      .every((result) => result?.error !== 'analysis_start_not_implemented'),
    selected: valueFixture.prefs.readStored().pluginSettings.analysis.triageModel,
    cleared: nullFixture.prefs.readStored().pluginSettings.analysis.triageModel,
  }, {
    lifecycle: true,
    selected,
    cleared: null,
  });
});

test('неразрешимый legacy alias оставляет null и даёт typed-отказ запуска', async (t) => {
  const { analyzer, prefs } = await migrationAnalyzer(t, { legacy: 'retired-unknown-model' });

  const started = await startAnalyzer(analyzer);
  const run = started?.error === 'analysis_start_not_implemented'
    ? started
    : await analyzer.analyze('42');

  assert.deepEqual({
    setting: prefs.readStored().pluginSettings?.analysis?.triageModel,
    run,
  }, {
    setting: null,
    run: { ok: false, error: 'analysis_model_unavailable' },
  });
});
