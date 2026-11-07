import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Analyzer } from '../../server/src/lib/analysis/analyzer.ts';
import { parseRouteMap, resolveDepth, resolveRoute } from '../../server/src/lib/analysis/routePolicy.ts';

const ROUTE_MAP = 'feature:light=trivial feature:mid=small feature:full=feature '
  + 'debug:light=fix debug:mid=fix debug:full=debug perf:full=perf';
const ROUTES = ['debug', 'feature', 'fix', 'perf', 'small', 'trivial'];

function estimate(extra = {}) {
  return {
    complexity: 2,
    risk: 2,
    diff_size: 'S',
    confidence: 'high',
    questions: [],
    needs_clarification: false,
    route_kind: 'feature',
    ...extra,
  };
}

test('глубина считается по оценке, а риск и открытые вопросы её не пускают вниз', () => {
  assert.equal(resolveDepth(estimate()).depth, 'light');
  assert.equal(resolveDepth(estimate({ risk: 4 })).depth, 'full');
  assert.equal(resolveDepth(estimate({ complexity: 4 })).depth, 'full');
  assert.equal(resolveDepth(estimate({ diff_size: 'M' })).depth, 'mid');
  assert.equal(resolveDepth(estimate({ risk: 3 })).depth, 'mid');
  assert.equal(resolveDepth(estimate({ confidence: 'medium' })).depth, 'mid');
  // Нерешённый вопрос дороже сэкономленных минут: ответ на него меняет и объём работы.
  assert.equal(resolveDepth(estimate({ questions: [{ id: 'q1', text: 'какой вариант?' }] })).depth, 'mid');
  assert.equal(resolveDepth(estimate({ needs_clarification: true })).depth, 'mid');
  assert.equal(resolveDepth(estimate({ diff_size: 'L' })).depth, 'full');
  assert.equal(resolveDepth({ complexity: null, risk: null }).depth, 'full');
  assert.match(resolveDepth(estimate({ risk: 5 })).reason, /риск 5/u);
});

test('карта профиля разбирается терпимо к мусору и не даёт повторам переопределять ключ', () => {
  const { byKey, kinds } = parseRouteMap(
    'feature:light=trivial мусор feature:light=other debug:full=debug feature:zzz=x',
  );
  assert.equal(byKey.get('feature:light'), 'trivial');
  assert.equal(byKey.get('debug:full'), 'debug');
  assert.equal(byKey.has('feature:zzz'), false);
  assert.deepEqual(kinds, ['feature', 'debug']);
});

test('род называет модель, маршрут выбирает карта профиля', () => {
  const light = resolveRoute(estimate(), { routeMap: ROUTE_MAP, routes: ROUTES });
  assert.deepEqual(
    { route: light.route, kind: light.kind, depth: light.depth },
    { route: 'trivial', kind: 'feature', depth: 'light' },
  );

  const mid = resolveRoute(estimate({ diff_size: 'M' }), { routeMap: ROUTE_MAP, routes: ROUTES });
  assert.equal(mid.route, 'small');

  const bug = resolveRoute(
    estimate({ route_kind: 'debug', risk: 4 }),
    { routeMap: ROUTE_MAP, routes: ROUTES },
  );
  assert.deepEqual({ route: bug.route, depth: bug.depth }, { route: 'debug', depth: 'full' });

  // У perf лёгкой ступени нет — политика штатно поднимает её до полного маршрута.
  const perf = resolveRoute(estimate({ route_kind: 'perf' }), { routeMap: ROUTE_MAP, routes: ROUTES });
  assert.deepEqual({ route: perf.route, depth: perf.depth }, { route: 'perf', depth: 'full' });
  assert.match(perf.reason, /этой ступени нет/u);
});

test('маршрут вне опубликованного каталога не предлагается', () => {
  const withoutLight = resolveRoute(estimate(), {
    routeMap: ROUTE_MAP,
    routes: ['feature', 'debug'],
  });
  assert.deepEqual({ route: withoutLight.route, depth: withoutLight.depth }, {
    route: 'feature', depth: 'full',
  });

  const unknownKind = resolveRoute(estimate({ route_kind: 'chore' }), {
    routeMap: ROUTE_MAP,
    routes: ROUTES,
  });
  assert.deepEqual({ route: unknownKind.route, kind: unknownKind.kind }, { route: null, kind: null });

  // Профиль без карты: род обязан совпасть с именем опубликованного маршрута.
  const legacy = resolveRoute({ ...estimate(), route_kind: undefined, route_guess: 'feature' }, {
    routeMap: '',
    routes: ROUTES,
  });
  assert.equal(legacy.route, 'feature');
  assert.equal(resolveRoute({ route_guess: 'нет-такого' }, { routeMap: '', routes: ROUTES }).route, null);
});

// Сквозная проверка: маршрут появляется в analysis.json от политики, а не от модели,
// и вместе с ним — профиль и hash каталога, по которым видно, к чему относится оценка.
test('раннер пишет в оценку маршрут политики, профиль и hash каталога', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'analysis-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const analysisDir = path.join(root, 'analysis');
  const profileDir = path.join(root, 'profiles', 'demo');
  await mkdir(analysisDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await writeFile(path.join(profileDir, 'profile.sh'), [
    'PROFILE_CTX="демо-стек"',
    `PROFILE_TRIAGE_ROUTES="${ROUTE_MAP}"`,
    '',
  ].join('\n'));
  await chmod(path.join(profileDir, 'profile.sh'), 0o644);

  const prompts = [];
  const executor = {
    id: 'codex',
    scopedWorkspace: true,
    async run(options) {
      const prompt = String(options.message || options.prompt || '');
      prompts.push(prompt);
      const jsonPath = prompt.match(/(?:- |\[Схема )([^\s\]]+\.analysis\.json)/)?.[1];
      await mkdir(path.dirname(jsonPath), { recursive: true });
      // Модель называет только род работы; про маршрут и глубину её никто не спрашивает.
      await writeFile(jsonPath, JSON.stringify({
        task: 77,
        route_kind: 'feature',
        complexity: 2,
        risk: 2,
        diff_size: 'S',
        confidence: 'high',
        questions: [],
        needs_clarification: false,
        summary: 'мелкая правка',
      }));
      return { reply: 'ok', cost: 0.01 };
    },
  };

  const analyzer = new Analyzer({
    config: {
      analysisDir,
      chatsDir: path.join(root, 'chats'),
      factoryHome: root,
      profilesDir: path.join(root, 'profiles'),
      factoryProfile: 'demo',
      analysisTimeoutMs: 1000,
      analysisConcurrency: 1,
    },
    claudeAuth: { env: () => process.env },
    tracker: {
      async taskDetail() { return { title: 'Demo | мелочь', description: '' }; },
      async taskPageData() { return { comments: [] }; },
    },
    factoryState: {
      async primaryProfile() { return 'demo'; },
      async catalog(profile) {
        assert.equal(profile, 'demo');
        return {
          catalogHash: 'a'.repeat(64),
          routes: ROUTES,
          routeOptions: { trivial: { title: 'Trivial v2: малое изменение' } },
        };
      },
    },
    prefs: { read: () => ({}) },
    log: null,
    pluginEnabled: () => true,
    pluginSettings: () => ({ triageModel: { provider: 'codex', model: 'm' }, autoArbitrate: false }),
    providerRegistry: async () => ({ codex: [{ id: 'm', efforts: [] }] }),
    executorFor: async () => executor,
  });
  await analyzer._ready;

  const run = await analyzer.analyze('77');
  assert.equal(run.ok, true, run.error);
  const saved = JSON.parse(await readFile(path.join(analysisDir, 't77.analysis.json'), 'utf8'));
  assert.deepEqual({
    route_guess: saved.route_guess,
    route_kind: saved.route_kind,
    route_depth: saved.route_depth,
    route_profile: saved.route_profile,
    route_catalog_hash: saved.route_catalog_hash,
  }, {
    route_guess: 'trivial',
    route_kind: 'feature',
    route_depth: 'light',
    route_profile: 'demo',
    route_catalog_hash: 'a'.repeat(64),
  });
  assert.match(saved.route_reason, /сложность 2, риск 2/u);
  // Промпт спрашивает род из карты профиля и показывает опубликованные маршруты.
  assert.match(prompts[0], /route_kind \(род работы, НЕ глубина проверки\): feature \| debug \| perf/u);
  assert.match(prompts[0], /- trivial — Trivial v2: малое изменение/u);
});
