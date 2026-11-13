import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Analyzer } from '../../../server/src/lib/analysis/analyzer.ts';
import analysisModule from '../../../server/src/modules/analysis/index.ts';
import { driverContext, multiFixture } from './trackerMulti.js';

export const MODEL = {
  provider: 'codex',
  model: 'fixture-model',
  effort: 'high',
};
export const modelRegistry = async () => ({ codex: [{ id: MODEL.model, efforts: ['high'] }] });
export const sourceQuery = (source) => `source=${encodeURIComponent(source)}`;

/**
 * Ожидает наблюдаемое завершение работы с ограниченным сроком.
 * Ошибка показывает последний снимок, чтобы отказ worker не маскировался тайм-аутом.
 */
export async function eventually(read, accepts, message = 'Ожидаемое состояние не наступило') {
  let value;

  for (let attempt = 0; attempt < 300; attempt += 1) {
    value = await read();

    if (accepts(value)) {
      return value;
    }

    await delay(10);
  }

  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

/**
 * Записывает результат только в выданный Analyzer staging из prompt.
 * Заголовок настоящего драйвера определяет разные ответы модели для A и B.
 */
export async function recordAnalysis(options, prompts, resultFor = null) {
  const prompt = String(options.message || options.prompt);
  const json = prompt.match(/(?:- |\[Схема )([^\s\]]+\.analysis\.json)/)?.[1];
  const note = prompt.match(/- ([^\s]+\/t\d+\.md)/)?.[1];

  assert.ok(json, 'Раннер получил путь результата от сервера');
  prompts.push(prompt);

  const label = prompt.includes('fixture-a') ? 'A' : 'B';
  const task = Number(path.basename(json).match(/^t(\d+)/)[1]);
  const result = {
    task,
    summary: `Оценка ${label}`,
    complexity: label === 'A' ? 2 : 4,
    risk: label === 'A' ? 1 : 5,
    files: [],
    unknowns: [`Неизвестное ${label}`],
    questions: [{
      id: `q-${label}`,
      text: `Вопрос ${label}`,
      kind: 'factual',
      options: [],
    }],
    ...(resultFor ? resultFor(label, task) : {}),
  };

  await mkdir(path.dirname(json), { recursive: true });
  await writeFile(json, JSON.stringify(result));

  if (note) {
    await writeFile(note, `Разведка ${label}`);
  }

  return { reply: 'ok', actualModel: MODEL.model };
}

/**
 * Собирает настоящий HTTP → Analyzer → facade с двумя исполняемыми драйверами.
 * Подменяется только внешняя модель; все пути принадлежат временной фикстуре.
 */
export async function analysisSourceFixture(t, {
  held = false, resultFor = null, register = null, fetch = undefined,
} = {}) {
  let analyzer;
  let dependencies;
  const prompts = [];
  const fixture = await multiFixture(t, {
    fetch,
    register: async (context) => {
      const { app, config, runtime } = context;

      Object.assign(config, {
        factoryProfile: '',
        analysisConcurrency: 1,
        analysisTimeoutMs: 5000,
        chatsDir: path.join(config.stateDir, 'chats'),
        factoryTaskSourcesPath: path.join(config.stateDir, 'factory-task-sources.json'),
      });
      dependencies = {
        config,
        tracker: runtime.tracker,
        factoryState: { primaryProfile: async () => null },
        prefs: { read: () => ({}) },
        pluginEnabled: () => true,
        pluginSettings: () => ({ triageModel: MODEL, autoArbitrate: false }),
        providerRegistry: modelRegistry,
        executorFor: async () => ({
          id: 'codex',
          scopedWorkspace: true,
          run: (options) => recordAnalysis(options, prompts, resultFor),
        }),
        log: null,
      };
      analyzer = new Analyzer(dependencies);
      await analyzer._ready;

      if (held) {
        analyzer._active = 1;
      }

      await app.register(analysisModule, { analyzer, tracker: runtime.tracker });
      await register?.({
        ...context,
        analyzer,
        dependencies,
      });
    },
  });
  const a = await driverContext(fixture, 'fixture-a');
  const b = await driverContext(fixture, 'fixture-b');

  t.after(async () => {
    await eventually(() => analyzer._jobs.size, (size) => held || size === 0);
  });

  return {
    ...fixture,
    analyzer,
    dependencies,
    prompts,
    a,
    b,
  };
}

/**
 * Читает реальный пакет через HTTP, сохраняя полный источник в query.
 * Терминальный failed возвращается немедленно и проверяется самим тестом.
 */
export async function completed(fixture, source, id = '42') {
  return eventually(async () => {
    const response = await fixture.request('GET', `/api/analysis/${id}?${sourceQuery(source)}`);

    assert.equal(response.statusCode, 200, response.body);

    return response.json();
  }, (detail) => ['done', 'failed', 'interrupted'].includes(detail.status?.state));
}

/**
 * Снимок всех файлов пакета нужен для доказательства отсутствия побочной записи в B.
 * Обходит только временный каталог теста и не касается данных установленного приложения.
 */
export async function packageBytes(directory) {
  const result = {};

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      Object.assign(result, await packageBytes(file));
    } else {
      result[file] = await readFile(file, 'utf8');
    }
  }

  return result;
}
