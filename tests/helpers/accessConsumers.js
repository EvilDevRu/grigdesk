import fs from 'node:fs/promises';
import path from 'node:path';

import { Analyzer } from '../../server/src/lib/analysis/analyzer.ts';
import { AnalysisArbiter } from '../../server/src/lib/analysis/arbiter.ts';
import { runInboxTriage } from '../../server/src/lib/inbox/triage.ts';
import { runMeetingPlan } from '../../server/src/lib/media/meetingPlan.ts';
import { createScriptOps } from '../../server/src/lib/showcase/scriptOps.ts';
import { createPluginRuntimeServices } from '../../server/src/modules/plugins/runtimeServices.ts';
import { ArbiterConversationStore } from '../../server/src/lib/arbiterConversationStore.ts';
import { runArbiterConversation } from '../../server/src/lib/arbiterConversationRunner.ts';
import { resolvedAdapter, runChat, saveChat } from './accessProfiles.js';

const REF = { provider: 'synthetic-access', model: 'fixture-model' };
const REGISTRY = { 'synthetic-access': [{ id: 'fixture-model', efforts: [] }] };

/**
 * Резолвер меняет только каталог модели; запуск остаётся у production-декоратора.
 * Сохранённый consumer получает выбранный доступ в момент вызова, а не создания функции.
 */
async function target(f) {
  return {
    ok: true,
    ref: REF,
    effort: null,
    executor: await resolvedAdapter(f),
  };
}

/**
 * Настоящий Analyzer использует временные источники и staging-каталог.
 * Неготовый итог фикстуры допустим: предмет AP19 — фактический env внешнего вызова.
 */
async function analyzer(f) {
  const value = new Analyzer({
    config: {
      ...f.config,
      analysisTimeoutMs: 2000,
      analysisConcurrency: 1,
      factoryProfile: '',
    },
    tracker: {
      taskDetail: async () => ({ title: 'Задача фикстуры', description: '' }),
      taskPageData: async () => ({ comments: [] }),
    },
    factoryState: { primaryProfile: async () => null },
    prefs: { read: () => ({}) },
    pluginEnabled: () => true,
    pluginSettings: () => ({ triageModel: REF, autoArbitrate: false }),
    providerRegistry: async () => REGISTRY,
    executorFor: async () => resolvedAdapter(f),
    log: null,
  });

  await value._ready;

  return value;
}

/**
 * Порты источников showcase не открывают репозитории человека.
 * Вызов генерации и безопасный model-only transport остаются настоящими.
 */
function showcase(f) {
  const project = {
    id: 'fixture',
    revision: 1,
    title: 'Ролик',
    ref: { kind: 'sandbox', id: 'fixture' },
    target: { status: 'ready', scope: { profile: 'fixture', targetFingerprint: 'fixture' } },
    scenes: [],
    decisions: [],
  };

  return createScriptOps({
    assertEnabled() {},
    broadcast() {},
    limits: () => ({ maxScenes: 5 }),
    readProject: async () => project,
    resolveScriptModel: () => target(f),
    scriptModelRef: () => REF,
    executorConfig: () => f.config,
    providerSettings: () => ({}),
    acquireTargetLease: async () => null,
    store: { updateProject: async (id, revision, patch) => patch(project) },
    targets: {
      selectedInternalScope: async () => ({
        profile: 'fixture',
        sandbox: { repos: [] },
        screens: [{
          id: 'overview',
          title: 'Обзор',
          path: '/',
          elements: []
        }],
      }),
    },
    publish: (value) => value,
  });
}

/**
 * Служебный диалог получает подлинный durable store с attempt identity.
 * Тест не подменяет runner и не вызывает модель через его частный helper.
 */
async function conversation(f, index) {
  const store = new ArbiterConversationStore(path.join(f.root, 'arbiter-conversations'));
  const identity = {
    task: String(index + 7),
    profile: 'fixture',
    attempt: `a_${'a'.repeat(32)}`,
    node: 'verify',
    stop: 'human',
    stageSequence: 2,
    stageHeadHash: 'b'.repeat(64),
  };
  const doc = await store.create(identity, {
    status: 'supported',
    message: '',
    targets: []
  });

  await store.update(identity.task, doc.id, (current) => {
    current.state = 'analyzing';
    current.operations.push({
      id: 'turn',
      requestId: 'request',
      fingerprint: 'a'.repeat(64),
      kind: 'start',
      outcome: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  const context = {
    identity,
    targets: [],
    sourceText: 'Проверка фикстуры',
    evidence: {},
    sourceLabel: 'Проверка',
    policies: [],
    reportPath: null,
  };

  return runArbiterConversation({
    store,
    doc,
    context,
    operationId: 'turn',
    executor: await resolvedAdapter(f),
    input: {
      config: f.config,
      model: REF.model,
      cwd: f.root
    },
    readCurrent: async () => context,
  });
}

/**
 * Таблица состоит из настоящих entrypoints, а не нескольких вызовов одного helper.
 * Их внешние порты каталогов и данных ограничены каталогом текущего теста.
 */
export async function consumer(f, name) {
  if (name === 'chat') {
    await saveChat(f);

    return () => runChat(f, { profileId: 'forged-profile', env: { DEEPSEEK_API_KEY: 'forged-key' } });
  }

  if (name === 'service') {
    const adapter = await resolvedAdapter(f);

    return () => adapter.runUntrusted({
      config: f.config,
      model: REF.model,
      message: 'Служебный запрос'
    });
  }

  if (name === 'modelText') {
    const services = createPluginRuntimeServices({
      config: f.config,
      resolveTarget: () => target(f),
    });

    return () => services.modelText({ modelRef: REF, message: 'Служебный запрос плагина' });
  }

  if (name === 'inbox') {
    return () => runInboxTriage({
      item: {
        title: 'Письмо',
        text: 'Нужно исправить ошибку',
        messages: []
      },
      modelRef: REF,
      config: f.config,
      modelsRegistry: async () => REGISTRY,
      executorResolver: () => resolvedAdapter(f),
      log: null,
    });
  }

  if (name === 'meeting') {
    return () => runMeetingPlan({
      segments: [{
        start: 0,
        end: 1,
        text: 'Нужно исправить ошибку'
      }],
      modelRef: REF,
      config: f.config,
      resolveTarget: () => target(f),
      log: null,
    });
  }

  if (name === 'showcase') {
    const ops = showcase(f);

    f.control.reply = JSON.stringify({ points: ['Первое действие', 'Второе действие', 'Результат'] });

    return () => ops.generateBrief('fixture', 'Показать новый интерфейс');
  }

  const analysis = await analyzer(f);
  let index = 0;

  if (name === 'analysis') {
    return () => analysis.analyze(String(++index + 40));
  }

  if (name === 'analysis-arbiter') {
    const arbiter = new AnalysisArbiter({
      analyzer: analysis,
      pluginEnabled: () => true,
      pluginSettings: () => ({ triageModel: REF }),
      providerRegistry: async () => REGISTRY,
      executorFor: () => resolvedAdapter(f),
    });

    return async () => {
      const id = String(++index + 40);

      await fs.writeFile(path.join(f.config.analysisDir, `t${id}.analysis.json`), JSON.stringify({
        task: Number(id),
        questions: [{
          id: 'fact',
          text: 'Существует ли настройка?',
          options: []
        }],
      }));

      return arbiter.arbitrate(id);
    };
  }

  return () => conversation(f, ++index);
}
