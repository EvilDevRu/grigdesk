import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Analyzer } from '../../server/src/lib/analysis/analyzer.ts';

const RESULT = {
  task: 42,
  project: 'Demo',
  route_guess: 'feature',
  complexity: 2,
  risk: 2,
  diff_size: 'S',
  areas: ['FE'],
  files: [],
  risk_markers: [],
  unknowns: [],
  questions: [],
  needs_clarification: false,
  confidence: 'high',
  summary: 'Фото прочитано.',
};

/** Собирает обычные файлы доступного корня так же, как их увидит файловый tool агента. */
async function filesBelow(root) {
  const result = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(target));
    else if (entry.isFile()) result.push(target);
  }
  return result;
}

/** Эмулятор модели записывает результат только в server-owned staging из prompt. */
async function writeRunFiles(options) {
  const prompt = String(options.message || options.prompt || '');
  const jsonPath = prompt.match(/(?:- |\[Схема )([^\s\]]+\.analysis\.json)/)?.[1];
  const notePath = prompt.match(/- ([^\s]+\/t42\.md)/)?.[1];
  if (!jsonPath) throw new Error('в prompt нет server-owned analysis path');
  await mkdir(path.dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(RESULT));
  if (notePath) await writeFile(notePath, '# Разведка\n');
}

test('выбранное фото читается только из per-run input и не становится доступным для записи', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'analysis-attachments-'));
  const analysisDir = path.join(root, 'analysis');
  const chatsDir = path.join(root, 'chats');
  const attachmentRoot = path.join(chatsDir, 'attachments');
  await mkdir(analysisDir);
  await mkdir(attachmentRoot, { recursive: true });
  await writeFile(path.join(attachmentRoot, 'selected.png'), 'selected-photo-bytes');
  await writeFile(path.join(attachmentRoot, 'unselected.png'), 'private-photo-bytes');
  await writeFile(path.join(analysisDir, 't42.analysis.json'), JSON.stringify({
    task: 42,
    questions: [{ id: 'q-screen', text: 'Что видно на снимке?', options: [] }],
  }));
  const marker = Buffer.from(JSON.stringify({
    id: 'answer-screen',
    questionId: 'q-screen',
    actor: 'human',
    status: 'answered',
    selection: [],
    text: 'Снимок приложен.',
    attachments: [{ file: 'selected.png', name: '..' }],
  })).toString('base64url');
  await writeFile(path.join(analysisDir, 't42.clarify.md'), [
    '## Ответ человека',
    'Снимок приложен.',
    `<!-- grigdesk-clarification:v1 ${marker} -->`,
    '',
  ].join('\n'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const calls = [];
  const executor = {
    id: 'codex',
    scopedWorkspace: true,
    async run(options) {
      const access = options.workspaceAccess || {};
      const readableFiles = (await Promise.all(
        (access.readableRoots || []).map((entry) => filesBelow(entry)),
      )).flat();
      const materialized = readableFiles.find((entry) => path.basename(entry) === 'screen.png')
        || readableFiles.find((entry) => path.basename(entry) === 'selected.png');
      calls.push({
        access,
        prompt: String(options.message || options.prompt || ''),
        readableFiles,
        materialized,
        bytes: materialized ? await readFile(materialized, 'utf8') : null,
      });
      await writeRunFiles(options);
      return { reply: 'ok', actualModel: options.model };
    },
  };
  const analyzer = new Analyzer({
    config: {
      analysisDir,
      analysisModel: 'legacy-model',
      claudeBin: path.join(root, 'legacy-claude'),
      chatsDir,
      factoryHome: root,
      profilesDir: path.join(root, 'profiles'),
      factoryProfile: '',
      analysisTimeoutMs: 1000,
      analysisConcurrency: 1,
    },
    claudeAuth: { env: () => process.env },
    tracker: {
      async taskDetail() { return { title: 'Demo | задача', description: '' }; },
      async taskPageData() { return { comments: [] }; },
    },
    factoryState: { async primaryProfile() { return null; } },
    prefs: { read: () => ({}) },
    log: null,
    pluginEnabled: () => true,
    pluginSettings: () => ({
      triageModel: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
      autoArbitrate: false,
    }),
    providerRegistry: async () => ({ codex: [{ id: 'gpt-5.6-sol', efforts: ['high'] }] }),
    executorFor: async () => executor,
  });
  await analyzer._ready;

  const result = await analyzer.analyze('42');
  const call = calls[0] || { access: {}, readableFiles: [] };
  const writable = call.access.writableRoots || [];

  assert.deepEqual({
    result,
    calls: calls.length,
    bytes: call.bytes,
    materializedInsideAnalysis: call.materialized
      ? !path.relative(analysisDir, call.materialized).startsWith('..')
      : false,
    materializedWritable: call.materialized
      ? writable.some((entry) => !path.relative(entry, call.materialized).startsWith('..'))
      : false,
    unselectedVisible: call.readableFiles.some((entry) => path.basename(entry) === 'unselected.png'),
    commonRootGranted: [...(call.access.readableRoots || []), ...writable]
      .includes(attachmentRoot),
    promptUsesCopy: call.prompt?.includes(call.materialized || ''),
    promptLeaksCommonRoot: call.prompt?.includes(attachmentRoot),
    inputCleaned: call.materialized
      ? await stat(call.materialized).then(() => false, () => true)
      : false,
  }, {
    result: { ok: true },
    calls: 1,
    bytes: 'selected-photo-bytes',
    materializedInsideAnalysis: true,
    materializedWritable: false,
    unselectedVisible: false,
    commonRootGranted: false,
    promptUsesCopy: true,
    promptLeaksCommonRoot: false,
    inputCleaned: true,
  });
});

test('пропавший token и symlink наружу становятся недоступными без утечки сырого пути', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'analysis-attachments-invalid-'));
  const analysisDir = path.join(root, 'analysis');
  const chatsDir = path.join(root, 'chats');
  const attachmentRoot = path.join(chatsDir, 'attachments');
  const outside = path.join(root, 'outside-secret.png');
  await mkdir(analysisDir);
  await mkdir(attachmentRoot, { recursive: true });
  await writeFile(outside, 'outside-secret-bytes');
  await symlink(outside, path.join(attachmentRoot, 'linked.png'));
  await writeFile(path.join(analysisDir, 't42.analysis.json'), JSON.stringify({
    task: 42,
    questions: [{ id: 'q-screen', text: 'Что видно на снимке?', options: [] }],
  }));
  const marker = Buffer.from(JSON.stringify({
    id: 'answer-invalid-screen',
    questionId: 'q-screen',
    actor: 'human',
    status: 'answered',
    selection: [],
    text: 'Два снимка приложены.',
    attachments: [
      { file: 'missing.png', name: 'missing.png' },
      { file: 'linked.png', name: 'linked.png' },
    ],
  })).toString('base64url');
  await writeFile(path.join(analysisDir, 't42.clarify.md'), [
    '## Ответ человека',
    'Два снимка приложены.',
    `<!-- grigdesk-clarification:v1 ${marker} -->`,
    '',
  ].join('\n'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompts = [];
  const executor = {
    id: 'codex',
    scopedWorkspace: true,
    async run(options) {
      prompts.push(String(options.message || options.prompt || ''));
      await writeRunFiles(options);
      return { reply: 'ok', actualModel: options.model };
    },
  };
  const analyzer = new Analyzer({
    config: {
      analysisDir,
      analysisModel: 'legacy-model',
      claudeBin: path.join(root, 'legacy-claude'),
      chatsDir,
      factoryHome: root,
      profilesDir: path.join(root, 'profiles'),
      factoryProfile: '',
      analysisTimeoutMs: 1000,
      analysisConcurrency: 1,
    },
    claudeAuth: { env: () => process.env },
    tracker: {
      async taskDetail() { return { title: 'Demo | задача', description: '' }; },
      async taskPageData() { return { comments: [] }; },
    },
    factoryState: { async primaryProfile() { return null; } },
    prefs: { read: () => ({}) },
    log: null,
    pluginEnabled: () => true,
    pluginSettings: () => ({
      triageModel: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
      autoArbitrate: false,
    }),
    providerRegistry: async () => ({ codex: [{ id: 'gpt-5.6-sol', efforts: ['high'] }] }),
    executorFor: async () => executor,
  });
  await analyzer._ready;

  const result = await analyzer.analyze('42');
  const prompt = prompts[0] || '';

  assert.deepEqual({
    result,
    unavailable: (prompt.match(/вложение недоступно/giu) || []).length,
    leaksOutsidePath: prompt.includes(outside),
    leaksOutsideBytes: prompt.includes('outside-secret-bytes'),
  }, {
    result: { ok: true },
    unavailable: 2,
    leaksOutsidePath: false,
    leaksOutsideBytes: false,
  });
});
