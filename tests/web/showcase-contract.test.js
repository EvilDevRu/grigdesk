// Контракт раздела «Презентации» на стороне клиента: что принимается за данные
// раздела, а что обязано отвергаться.
//
// Ответ сервера приходит по сети и до проверки данными не является. Особенно это
// важно здесь: по «готовой цели» раздел запускает браузер на адресе стенда, а по
// состоянию задания рисует ход небесплатной работы.
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';

const contract = await compileModule(webFile('../shared/plugins/showcase/showcaseContracts.ts'));
const sceneDraft = await compileModule(webFile('src/views/showcase/sceneDraft.ts'));

const SCOPE = {
  targetKind: 'sandbox',
  targetLabel: 'стенд 990001',
  profile: 'demo-profile',
  viewUrl: 'http://127.0.0.1:5192',
  environment: 'read-only',
  capabilities: ['record'],
  screens: [{ id: 'overview', title: 'Обзор', path: '/' }],
  targetFingerprint: 'fingerprint',
  policyRevision: 'policy',
  // Ревизия словаря карты необязательна: старые ответы её не несут.
  mapRevision: 'map',
  dataRevision: 'начальные',
  buildRevision: null,
};

const JOB = {
  id: 'job-1',
  projectId: 'project-1',
  kind: 'record',
  state: 'running',
  attempt: 1,
  sequence: 2,
  progress: { index: 1, total: 3, label: 'пишем сцену' },
  error: null,
  startedAt: '2026-09-09T10:00:00.000Z',
  finishedAt: null,
};

test('обзор принимает готовую цель без карты экранов', () => {
  const target = {
    ref: { kind: 'project', id: 'parser' },
    profile: 'parser',
    profileBinding: null,
    label: 'parser · постоянный стенд',
    // Старый ответ без названия задачи читается как «названия нет».
    taskTitle: null,
    viewUrl: 'http://127.0.0.1:13000',
    viewPort: null,
    serviceHost: null,
    status: 'ready',
    reason: '',
    screenCount: 0,
  };
  const overview = {
    targets: [target],
    profiles: [],
    projects: [],
    jobs: [],
    limits: {
      maxScenes: 20,
      maxSceneSeconds: 120,
      maxTotalSeconds: 600,
      retentionDays: 30,
    },
  };

  assert.deepEqual(contract.parseShowcaseOverview(overview).targets, [target]);
  assert.throws(
    () => contract.parseShowcaseOverview({
      ...overview,
      targets: [{ ...target, status: 'почти готово' }],
    }),
    contract.ShowcaseContractError,
  );
  assert.throws(
    () => contract.parseShowcaseOverview({
      ...overview,
      targets: [{ ...target, screenCount: -1 }],
    }),
    contract.ShowcaseContractError,
  );
});

test('готовая цель и заблокированная разбираются как разные ветки', () => {
  const ready = {
    status: 'ready',
    ref: { kind: 'sandbox', id: '990001' },
    scope: SCOPE,
  };
  const blocked = {
    status: 'blocked',
    ref: { kind: 'task', id: '990002' },
    profile: null,
    reason: 'Стенд не найден в реестре.',
    nextAction: {
      kind: 'open-sandboxes',
      label: 'Открыть «Песочницы»',
      hint: 'Поднимите стенд задачи.',
    },
  };

  assert.deepEqual(contract.parseShowcaseTarget(ready), ready);
  assert.deepEqual(contract.parseShowcaseTarget(blocked), blocked);
});

test('«готово» без области показа целью не считается', () => {
  // Ветку выбирает метка состояния, а дальше работает её собственный декодер:
  // «готово» без области — это расходящийся ответ, и показать по нему кнопку
  // записи значило бы запустить браузер туда, куда сервер ходить не разрешил.
  assert.throws(
    () => contract.parseShowcaseTarget({
      status: 'ready',
      ref: { kind: 'sandbox', id: '990001' },
      reason: 'Стенда нет.',
      nextAction: null,
    }),
    contract.ShowcaseContractError,
  );
});

test('лишние поля ответа не становятся состоянием раздела', () => {
  const parsed = contract.parseShowcaseTarget({
    status: 'ready',
    ref: { kind: 'sandbox', id: '990001' },
    scope: { ...SCOPE, recordUrl: 'http://127.0.0.1:9999', allowedOrigins: ['*'] },
    reason: 'Поле из чужой ветки.',
  });

  assert.equal(parsed.status, 'ready');
  assert.ok(!('reason' in parsed), 'поле чужой ветки в состояние не попадает');
  assert.ok(!('recordUrl' in parsed.scope), 'адрес записи в состояние не попадает');
  assert.ok(!('allowedOrigins' in parsed.scope), 'список назначений в состояние не попадает');
});

test('незнакомое состояние задания не проходит за известное', () => {
  assert.deepEqual(contract.parseShowcaseJob(JOB), JOB);

  for (const invalid of [
    { ...JOB, state: 'почти готово' },
    { ...JOB, kind: 'что-то' },
    { ...JOB, sequence: -1 },
    { ...JOB, sequence: 1.5 },
    { ...JOB, progress: { index: 1, total: 3 } },
    { ...JOB, startedAt: null },
  ]) {
    assert.throws(() => contract.parseShowcaseJob(invalid), contract.ShowcaseContractError);
  }
});

test('вид цели и среда показа закрыты перечислением', () => {
  for (const kind of ['project', 'sandbox', 'task']) {
    const value = {
      status: 'ready',
      ref: { kind, id: 'demo-profile' },
      scope: { ...SCOPE, targetKind: kind },
    };

    assert.equal(contract.parseShowcaseTarget(value).ref.kind, kind);
  }

  assert.throws(
    () => contract.parseShowcaseTarget({
      status: 'ready',
      ref: { kind: 'production', id: 'demo-profile' },
      scope: SCOPE,
    }),
    contract.ShowcaseContractError,
  );

  assert.throws(
    () => contract.parseShowcaseTarget({
      status: 'ready',
      ref: { kind: 'project', id: 'demo-profile' },
      scope: { ...SCOPE, environment: 'production' },
    }),
    contract.ShowcaseContractError,
  );
});

test('событие прогресса проверяется так же, как ответ ручки', () => {
  const event = {
    jobId: 'job-1',
    projectId: 'project-1',
    state: 'running',
    sequence: 4,
    label: 'сборка',
  };

  // Счётчик и причина отказа необязательны: у заявки в очереди нет ни того, ни другого.
  assert.deepEqual(
    contract.parseShowcaseProgressEvent(event),
    { ...event, index: null, total: null, error: null },
  );
  assert.equal(
    contract.parseShowcaseProgressEvent({ ...event, state: 'failed', error: 'вход не удался' }).error,
    'вход не удался',
  );

  for (const invalid of [
    null,
    { ...event, state: 'идёт' },
    { ...event, sequence: '4' },
    { ...event, label: null },
    { ...event, error: 42 },
    { ...event, index: -1 },
  ]) {
    assert.throws(
      () => contract.parseShowcaseProgressEvent(invalid),
      contract.ShowcaseContractError,
    );
  }
});

test('каталог голосов приносит и состояние установки', () => {
  const catalog = {
    engines: [
      {
        id: 'piper',
        name: 'Piper (локально)',
        kind: 'local',
        // Старый ответ без признака темпа читается как «признак не сообщён».
        pace: null,
        doctor: { status: 'blocked', reason: 'не установлен', install: 'нажмите «Установить»' },
        voices: [{
          id: 'irina',
          name: 'Ирина',
          language: 'ru',
          available: true,
          reason: '',
          capabilities: { pace: true, pause: true, stress: false },
        }],
      },
    ],
    install: {
      available: [
        {
          id: 'irina',
          engineId: 'piper',
          name: 'Ирина',
          language: 'ru',
          timbre: 'женский',
          byteSize: 58_340_190,
          license: 'GPLv2',
          voices: ['Ирина'],
          installed: false,
        },
      ],
      job: {
        id: 'attempt-1',
        engineId: 'piper',
        voiceId: 'irina',
        state: 'running',
        step: 'packages',
        label: 'ставлю движок',
        error: null,
        startedAt: '2026-09-09T10:00:00.000Z',
        finishedAt: null,
      },
    },
  };

  assert.deepEqual(contract.parseShowcaseVoiceCatalog(catalog), catalog);

  const legacyCatalog = structuredClone(catalog);

  delete legacyCatalog.engines[0].voices[0].capabilities;
  assert.equal(
    contract.parseShowcaseVoiceCatalog(legacyCatalog).engines[0].voices[0].capabilities,
    null,
    'старый ответ остаётся unknown',
  );

  for (const invalid of [
    { ...catalog, install: undefined },
    {
      ...catalog,
      install: { ...catalog.install, job: { ...catalog.install.job, state: 'ставится' } },
    },
    {
      ...catalog,
      engines: [{
        ...catalog.engines[0],
        voices: [{ ...catalog.engines[0].voices[0], capabilities: { pace: 'да' } }],
      }],
    },
    {
      ...catalog,
      install: {
        ...catalog.install,
        available: [{ ...catalog.install.available[0], byteSize: '58 МБ' }],
      },
    },
  ]) {
    assert.throws(
      () => contract.parseShowcaseVoiceCatalog(invalid),
      contract.ShowcaseContractError,
    );
  }
});

test('словарь ударений приходит текстом, записями и негодными строками с причиной', () => {
  const dictionary = {
    text: 'дин+амика\nплохо\n',
    entries: ['дин+амика'],
    errors: [{ line: 2, text: 'плохо', reason: 'нет знака ударения «+»' }],
  };

  assert.deepEqual(contract.parseShowcaseVoiceDictionary(dictionary), dictionary);

  for (const invalid of [
    { ...dictionary, text: null },
    { ...dictionary, entries: 'дин+амика' },
    { ...dictionary, errors: [{ line: '2', text: 'плохо', reason: 'нет знака' }] },
  ]) {
    assert.throws(
      () => contract.parseShowcaseVoiceDictionary(invalid),
      contract.ShowcaseContractError,
    );
  }
});

test('событие установки голоса проверяется так же, как ответ ручки', () => {
  const event = {
    installId: 'attempt-1',
    voiceId: 'irina',
    state: 'succeeded',
    step: 'done',
    label: 'голос готов',
    error: null,
  };

  assert.deepEqual(contract.parseShowcaseVoiceEvent(event), event);

  for (const invalid of [{ ...event, state: 'готово' }, { ...event, label: 3 }]) {
    assert.throws(
      () => contract.parseShowcaseVoiceEvent(invalid),
      contract.ShowcaseContractError,
    );
  }
});

test('ошибка контракта называет путь поля, но не его значение', () => {
  try {
    contract.parseShowcaseJob({ ...JOB, state: 'секретное-значение' });
    assert.fail('ожидалась ошибка контракта');
  } catch (error) {
    assert.ok(error instanceof contract.ShowcaseContractError);
    assert.match(error.message, /job\.state/);
    assert.ok(
      !error.message.includes('секретное-значение'),
      'значение поля в текст ошибки не попадает',
    );
  }
});

test('краткая карточка не выдумывает цель у заблокированного ролика', () => {
  const project = {
    schemaVersion: 1,
    id: 'project-1',
    title: 'Ролик',
    revision: 2,
    ref: { kind: 'task', id: '990002' },
    target: {
      status: 'blocked',
      ref: { kind: 'task', id: '990002' },
      reason: 'Стенд не найден в реестре.',
      nextAction: null,
    },
    brief: [],
    scenes: [],
    decisions: [],
    latestFinal: null,
    createdAt: '2026-09-09T10:00:00.000Z',
    updatedAt: '2026-09-09T11:00:00.000Z',
  };
  const summary = contract.toProjectSummary(contract.parseShowcaseProject(project), 'blocked');

  assert.equal(summary.targetLabel, '');
  assert.equal(summary.state, 'blocked');
  assert.equal(summary.hasFinal, false);
});

test('проект принимает безопасные sync-ссылки и три вида cue без служебных полей', () => {
  const artifact = (kind, id) => ({
    id,
    kind,
    inputHash: `${id}-input`,
    contentHash: `${id}-content`,
    producerVersion: `${kind}-1`,
    durationMs: kind === 'subtitles' ? null : 1200,
    byteSize: 4096,
  });
  const timingRef = (id) => ({
    id,
    inputHash: `${id}-input`,
    contentHash: `${id}-content`,
    producerVersion: `${id}-producer`,
    byteSize: 512,
    path: '/не-должен-выйти.json',
  });
  const project = {
    schemaVersion: 1,
    id: 'project-sync',
    title: 'Ролик с привязками',
    revision: 3,
    ref: { kind: 'project', id: 'demo-profile' },
    target: {
      status: 'blocked',
      ref: { kind: 'project', id: 'demo-profile' },
      reason: 'Тестовая цель не запущена.',
      nextAction: null,
    },
    brief: [],
    scenes: [{
      id: 'scene-sync',
      order: 1,
      title: 'Три состояния',
      screenId: 'overview',
      startState: null,
      readyCondition: null,
      continuesPrevious: false,
      actions: [
        { kind: 'click', targetId: 'open' },
        { kind: 'waitVisible', targetId: 'result' },
        { kind: 'highlight', targetId: 'result' },
      ],
      narration: 'замок открыт, результат готов, рамка видна',
      caption: 'Три состояния',
      subtitleText: 'Замок открыт, результат готов, рамка видна.',
      direction: { tone: null, pace: 'normal', emphasis: [], pauses: [], stresses: [] },
      pronunciationOverrides: [{
        from: 0,
        to: 5,
        pronunciation: 'з+амок',
        textHash: 'text-hash',
        voiceRef: 'edge:voice',
      }],
      timing: null,
      syncBindings: {
        version: 1,
        textHash: 'text-hash',
        actionsHash: 'actions-hash',
        cues: [
          {
            id: 'cue-open',
            actionIndex: 0,
            from: 0,
            to: 5,
            kind: 'align-start',
            origin: 'manual',
            selector: '#unsafe',
            url: 'https://unsafe.invalid',
          },
          {
            id: 'cue-ready',
            actionIndex: 1,
            from: 14,
            to: 29,
            kind: 'ready-before',
            origin: 'generated',
          },
          {
            id: 'cue-hold',
            actionIndex: 2,
            from: 31,
            to: 42,
            kind: 'hold-through',
            origin: 'manual',
          },
        ],
      },
      speechTiming: timingRef('speech-timing'),
      recordingTiming: timingRef('recording-timing'),
      audioSource: { kind: 'tts', voiceRef: 'edge:voice', artifactId: 'audio-1' },
      audio: artifact('audio', 'audio-1'),
      clip: artifact('clip', 'clip-1'),
      frame: null,
      checks: [],
      stale: false,
    }],
    decisions: [],
    latestFinal: {
      video: artifact('final', 'final-1'),
      subtitles: artifact('subtitles', 'subtitles-1'),
      manifestId: 'manifest-1',
      manifestVersion: 1,
      builtAt: '2026-09-12T10:00:00.000Z',
      current: true,
    },
    createdAt: '2026-09-12T09:00:00.000Z',
    updatedAt: '2026-09-12T10:00:00.000Z',
  };
  const parsed = contract.parseShowcaseProject(project);
  const [scene] = parsed.scenes;
  const expectedBindings = structuredClone(project.scenes[0].syncBindings);
  const expectedSpeechTiming = timingRef('speech-timing');
  const expectedRecordingTiming = timingRef('recording-timing');

  delete expectedBindings.cues[0].selector;
  delete expectedBindings.cues[0].url;
  delete expectedSpeechTiming.path;
  delete expectedRecordingTiming.path;

  assert.deepEqual(scene.syncBindings, expectedBindings);
  assert.deepEqual(scene.pronunciationOverrides, project.scenes[0].pronunciationOverrides);
  assert.deepEqual(scene.speechTiming, expectedSpeechTiming);
  assert.deepEqual(scene.recordingTiming, expectedRecordingTiming);
  assert.equal(parsed.latestFinal.manifestVersion, 1);

  const oldFinal = structuredClone(project);

  delete oldFinal.latestFinal.manifestVersion;
  assert.equal(contract.parseShowcaseProject(oldFinal).latestFinal.manifestVersion, null);

  const oldPronunciation = structuredClone(project);

  delete oldPronunciation.scenes[0].pronunciationOverrides;
  assert.equal(
    contract.parseShowcaseProject(oldPronunciation).scenes[0].pronunciationOverrides,
    null,
  );
});

test('sync-codec называет точное структурно неверное поле', () => {
  const base = {
    schemaVersion: 1,
    id: 'project-sync',
    title: 'Ролик',
    revision: 1,
    ref: { kind: 'project', id: 'demo' },
    target: {
      status: 'blocked',
      ref: { kind: 'project', id: 'demo' },
      reason: 'нет цели',
      nextAction: null,
    },
    brief: [],
    scenes: [{
      id: 'scene-1',
      order: 1,
      title: 'Сцена',
      screenId: 'root',
      startState: null,
      readyCondition: null,
      actions: [{ kind: 'click', targetId: 'open' }],
      narration: 'Открываем',
      caption: '',
      subtitleText: 'Открываем',
      direction: { tone: null, pace: null, emphasis: [], pauses: [], stresses: [] },
      timing: null,
      syncBindings: {
        version: 1,
        textHash: 'text',
        actionsHash: 'actions',
        cues: [{
          id: 'cue-1',
          actionIndex: 0,
          from: 0,
          to: 9,
          kind: 'align-start',
          origin: 'manual',
        }],
      },
      audioSource: { kind: 'tts', voiceRef: null, artifactId: null },
      audio: null,
      clip: null,
      frame: null,
      checks: [],
      stale: true,
    }],
    decisions: [],
    latestFinal: null,
    createdAt: '2026-09-12T09:00:00.000Z',
    updatedAt: '2026-09-12T09:00:00.000Z',
  };
  const cases = [
    ['version', 2],
    ['kind', 'wait-for-magic'],
    ['origin', 'model'],
    ['from', -1],
  ];
  const legacy = structuredClone(base);

  delete legacy.scenes[0].syncBindings;

  const [legacyScene] = contract.parseShowcaseProject(legacy).scenes;

  assert.equal(legacyScene.syncBindings, null);
  assert.equal(legacyScene.speechTiming, null);
  assert.equal(legacyScene.recordingTiming, null);

  for (const [field, value] of cases) {
    const invalid = structuredClone(base);

    if (field === 'version') {
      invalid.scenes[0].syncBindings.version = value;
    } else {
      invalid.scenes[0].syncBindings.cues[0][field] = value;
    }

    assert.throws(
      () => contract.parseShowcaseProject(invalid),
      (error) => error instanceof contract.ShowcaseContractError
        && error.message.includes(`syncBindings.${field === 'version' ? field : `cues[0].${field}`}`),
    );
  }
});

test('ручной sync-черновик отдаёт серверу только диапазон, действие и известный ID', () => {
  const scene = {
    id: 'scene-1',
    title: 'Сцена',
    narration: 'Показываем результат.',
    caption: '',
    subtitleText: 'Показываем результат.',
    syncBindings: {
      cues: [{
        id: 'cue-server',
        actionIndex: 0,
        from: 11,
        to: 20,
        kind: 'hold-through',
        origin: 'generated',
      }],
    },
  };
  const draft = sceneDraft.draftOf(scene);

  draft.syncCues[0] = {
    ...draft.syncCues[0],
    from: 0,
    to: 10,
    origin: 'manual',
  };

  const payload = sceneDraft.payloadOf(scene, draft);

  assert.deepEqual(payload.syncCues, [{
    id: 'cue-server',
    actionIndex: 0,
    from: 0,
    to: 10,
    kind: 'hold-through',
    manual: true,
  }]);
  assert.equal('origin' in payload.syncCues[0], false);
  assert.equal('textHash' in payload, false);
  assert.equal('actionsHash' in payload, false);
});

test('черновик произношения не отправляет hash и может явно обновить устаревший диапазон', () => {
  const scene = {
    id: 'scene-pronunciation',
    title: 'Замок',
    narration: 'Показываем замок.',
    caption: 'Замок',
    subtitleText: 'Показываем замок.',
    syncBindings: null,
    pronunciationOverrides: [{
      from: 11,
      to: 16,
      pronunciation: 'зам+ок',
      voiceRef: 'edge:voice',
      textHash: 'старая-редакция',
    }],
  };
  const draft = sceneDraft.draftOf(scene);

  draft.pronunciationOverrides[0] = {
    ...draft.pronunciationOverrides[0],
    textHash: null,
  };

  assert.equal(sceneDraft.draftChanged(scene, draft), true);
  assert.deepEqual(sceneDraft.payloadOf(scene, draft).pronunciationOverrides, [{
    from: 11,
    to: 16,
    pronunciation: 'зам+ок',
    voiceRef: 'edge:voice',
    refresh: true,
  }]);
});

// Источник рассказа — выбор человека. Контракт держит только форму: имя репозитория
// и коммиты остаются строками, а чужое поле не становится частью выбора.
const STORY_SOURCE = {
  task: false,
  note: 'Показать фильтры на доске',
  code: true,
  repos: [{
    name: 'frontend',
    work: true,
    commits: ['a'.repeat(40)],
  }],
};

const STORED_PROJECT = {
  schemaVersion: 1,
  id: 'project-1',
  title: 'Ролик',
  revision: 2,
  ref: { kind: 'sandbox', id: '990001' },
  target: {
    status: 'blocked',
    ref: { kind: 'sandbox', id: '990001' },
    reason: 'Стенд не найден в реестре.',
    nextAction: null,
  },
  brief: [],
  scenes: [],
  decisions: [],
  latestFinal: null,
  createdAt: '2026-10-08T10:00:00.000Z',
  updatedAt: '2026-10-08T11:00:00.000Z',
};

test('выбор «О чём ролик» принимается строго по форме, а умолчание — это null', () => {
  const parsed = contract.parseShowcaseStorySource({ ...STORY_SOURCE, path: '/srv/frontend' });

  assert.deepEqual(parsed, STORY_SOURCE, 'лишнее поле не становится частью выбора');
  assert.equal(contract.parseShowcaseStorySource({ ...STORY_SOURCE, repos: null }).repos, null);
  assert.throws(
    () => contract.parseShowcaseStorySource({ ...STORY_SOURCE, code: 'да' }),
    /поле source\.code/,
  );
  assert.throws(
    () => contract.parseShowcaseStorySource({
      ...STORY_SOURCE,
      repos: [{
        name: 'frontend',
        work: true,
        commits: [42],
      }],
    }),
    /поле source\.repos\[0\]\.commits\[0\]/,
  );
});

test('старый ролик без выбора читается умолчанием, а расхождение с выбором сцен видно', () => {
  const old = contract.parseShowcaseProject(STORED_PROJECT);
  const chosen = contract.parseShowcaseProject({
    ...STORED_PROJECT,
    source: STORY_SOURCE,
    scriptSource: null,
  });

  assert.equal(old.source, null);
  assert.equal(old.scriptSource, null);
  assert.deepEqual(chosen.source, STORY_SOURCE);
  assert.equal(contract.showcaseSourceEqual(old.source, old.scriptSource), true);
  assert.equal(contract.showcaseSourceEqual(chosen.source, chosen.scriptSource), false);
  assert.equal(contract.showcaseSourceEqual(null, undefined), true, 'нет поля — то же умолчание');
  assert.equal(contract.showcaseSourceEqual(STORY_SOURCE, { ...STORY_SOURCE }), true);
});

test('список выбора несёт коммиты и умолчание цели, но не пути репозиториев', () => {
  const repo = {
    name: 'frontend',
    branch: 'route-task-1',
    workFiles: 2,
    path: '/srv/frontend',
    commits: [{
      id: 'b'.repeat(40),
      subject: 'Фильтры на доске',
      date: '2026-10-08T10:00:00+07:00',
      own: true,
      merge: false,
    }],
    error: null,
  };
  const value = {
    taskAvailable: true,
    noteMax: contract.SHOWCASE_SOURCE_NOTE_MAX,
    defaults: {
      task: true,
      note: '',
      code: true,
      repos: [{
        name: 'frontend',
        work: true,
        commits: ['b'.repeat(40)],
      }],
    },
    requiresExplicitSelectionConfirmation: false,
    selectedOutsideCatalog: [],
    repos: [repo],
  };
  const options = contract.parseShowcaseSourceOptions(value);

  assert.equal(options.noteMax, 2000);
  assert.equal('path' in options.repos[0], false, 'путь репозитория остаётся на сервере');
  assert.equal(options.repos[0].commits[0].own, true);
  assert.equal(options.defaults.repos[0].commits[0], 'b'.repeat(40));
  assert.throws(
    () => contract.parseShowcaseSourceOptions({ ...value, repos: [{ ...repo, workFiles: -1 }] }),
    /поле sourceOptions\.repos\[0\]\.workFiles/,
  );
});

// Выбор, бриф и сцены хранят свой источник: запись переживает чтение целиком, а старая
// запись без полей остаётся умолчанием, а не повреждённым роликом.
test('запись со всеми тремя полями выбора переживает чтение, а старая — без них', () => {
  const stored = contract.parseShowcaseProject({
    ...STORED_PROJECT,
    source: STORY_SOURCE,
    briefSource: STORY_SOURCE,
    scriptSource: null,
  });
  const again = contract.parseShowcaseProject(JSON.parse(JSON.stringify(stored)));
  const old = contract.parseShowcaseProject(STORED_PROJECT);

  assert.deepEqual(again, stored);
  assert.deepEqual(stored.briefSource, STORY_SOURCE);
  assert.equal(stored.scriptSource, null);
  assert.equal(old.briefSource, null);
});

// Порядок кликов смысла не несёт: снять и вернуть галочку — тот же выбор. Умолчание же
// следует за веткой и не равно явному списку, даже если сейчас совпадает с ним.
test('тот же выбор в другом порядке равен себе, а умолчание отличается от явного списка', () => {
  const ordered = {
    ...STORY_SOURCE,
    note: 'Фильтры',
    repos: [
      {
        name: 'backend',
        work: false,
        commits: ['c'.repeat(40), 'd'.repeat(40)],
      },
      {
        name: 'frontend',
        work: true,
        commits: ['a'.repeat(40), 'b'.repeat(40)],
      },
    ],
  };
  const shuffled = {
    ...ordered,
    note: '  Фильтры ',
    repos: [
      {
        ...ordered.repos[1],
        commits: ['b'.repeat(40), 'a'.repeat(40)],
      },
      {
        ...ordered.repos[0],
        commits: ['d'.repeat(40), 'c'.repeat(40)],
      },
    ],
  };

  assert.equal(contract.showcaseSourceEqual(ordered, shuffled), true);
  assert.deepEqual(contract.normalizeShowcaseSource(shuffled), ordered);
  assert.equal(contract.normalizeShowcaseSource(null), null);
  assert.equal(contract.showcaseSourceEqual(ordered, { ...ordered, repos: null }), false);
  assert.equal(contract.showcaseSourceEqual(ordered, { ...ordered, task: true }), false);
});

test('список выбора несёт просьбу подтвердить сужение и выбор вне видимого списка', () => {
  const value = {
    taskAvailable: false,
    noteMax: 2000,
    defaults: {
      task: false,
      note: '',
      code: true,
      repos: [],
    },
    requiresExplicitSelectionConfirmation: true,
    selectedOutsideCatalog: [{
      name: 'frontend',
      missing: false,
      path: '/srv/frontend',
      commits: [
        {
          id: 'e'.repeat(40),
          subject: 'Старая работа',
          state: 'available',
        },
        {
          id: 'f'.repeat(40),
          subject: null,
          state: 'outdated',
        },
      ],
    }],
    repos: [],
  };
  const options = contract.parseShowcaseSourceOptions(value);
  const [group] = options.selectedOutsideCatalog;

  assert.equal(options.requiresExplicitSelectionConfirmation, true);
  assert.equal('path' in group, false, 'путь репозитория остаётся на сервере');
  assert.deepEqual(group.commits.map((commit) => commit.state), ['available', 'outdated']);
  assert.equal(group.commits[1].subject, null);
  assert.throws(
    () => contract.parseShowcaseSourceOptions({
      ...value,
      selectedOutsideCatalog: [{
        ...value.selectedOutsideCatalog[0],
        commits: [{
          id: 'f'.repeat(40),
          subject: null,
          state: 'lost',
        }],
      }],
    }),
    /поле sourceOptions\.selectedOutsideCatalog\[0\]\.commits\[0\]\.state/,
  );
});
