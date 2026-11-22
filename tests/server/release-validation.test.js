import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { validatePriorReleaseRun } from '../../tools/releaseValidation.mts';

const workflow = '.github/workflows/grigdesk-release.yml';
const current = 'a'.repeat(40);
const prior = 'b'.repeat(40);
const currentTree = 'e'.repeat(40);
const priorTree = 'f'.repeat(40);
const legacyWorkflow = '327853e9c7720731964077c47570ca1e0be46f6b';
const names = [
  'Общий прогон серверных проверок', 'Общий прогон web-проверок', 'Общая сборка web',
  'Ключ подписи', 'Сборка комплекта', 'Deb-пакет', 'Свидетельство проверок',
];

/**
 * Синтетический API содержит полный успешный прогон и два точных Git-дерева.
 * Меняется только проверяемый факт; сетевых запросов и настоящих ключей здесь нет.
 */
function fixture() {
  const entry = (name, sha = 'd'.repeat(40)) => ({
    path: name,
    type: 'blob',
    mode: '100644',
    sha,
  });
  const product = [entry('VERSION'), entry('server/src/app.ts'),
    entry('tests/web/client-phone.test.js'), entry('docs/grigdesk/guide/ru/chats.md')];
  const data = {
    '/actions/runs/42': {
      id: 42,
      status: 'completed',
      conclusion: 'success',
      event: 'workflow_dispatch',
      path: workflow,
      head_sha: prior,
      repository: { full_name: 'fixture/project' },
      head_repository: { full_name: 'fixture/project' },
    },
    '/actions/runs/42/jobs?per_page=100': {
      total_count: 1,
      jobs: [{
        status: 'completed',
        conclusion: 'success',
        steps: names.map((name) => ({
          name,
          status: 'completed',
          conclusion: 'success',
        })),
      }],
    },
    [`/git/commits/${current}`]: { sha: current, tree: { sha: currentTree } },
    [`/git/commits/${prior}`]: { sha: prior, tree: { sha: priorTree } },
    [`/git/trees/${currentTree}?recursive=1`]: {
      sha: currentTree,
      truncated: false,
      tree: [
        ...structuredClone(product),
        entry(workflow, 'c'.repeat(40)),
        entry('tools/releaseValidation.mts'),
      ],
    },
    [`/git/trees/${priorTree}?recursive=1`]: {
      sha: priorTree,
      truncated: false,
      tree: [...structuredClone(product), entry(workflow, legacyWorkflow)],
    },
  };
  const input = {
    repository: 'fixture/project',
    runId: '42',
    currentCommit: current,
    channel: 'release',
    version: '0.1.0',
    ref: 'refs/tags/v0.1.0',
  };

  return {
    input,
    run: () => data['/actions/runs/42'],
    jobs: () => data['/actions/runs/42/jobs?per_page=100'],
    attemptJobs: (jobs) => {
      data['/actions/runs/42/attempts/1/jobs?per_page=100'] = { total_count: jobs.length, jobs };
      data['/actions/runs/42'].run_attempt = 1;
    },
    tree: () => data[`/git/trees/${currentTree}?recursive=1`],
    source: () => data[`/git/trees/${priorTree}?recursive=1`],
    async verify() {
      return validatePriorReleaseRun(input, async (route) => {
        assert.ok(Object.hasOwn(data, route), route);

        return structuredClone(data[route]);
      });
    },
  };
}

test('reuse: совпадающий продукт допускает новые CI-файлы после полного зелёного прогона', async () => {
  const f = fixture();
  const proof = await f.verify();

  assert.equal(proof.runId, 42);
  assert.equal(proof.validatedCommit, prior);
  assert.equal(proof.currentCommit, current);
  assert.match(proof.productDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(proof.checks, names);
});

/**
 * Exact классические jobs и пять только skipped jobs входят в новый граф.
 * Metadata fixture намеренно поддерживает исключительно JSON-маршруты.
 */
function classicJobs(paired = true) {
  const steps = (list) => list.map((name) => ({
    name,
    status: 'completed',
    conclusion: 'success',
  }));
  const owner = {
    run_id: 42,
    head_sha: prior,
    status: 'completed',
  };
  const job = (name, list) => ({
    ...owner,
    name,
    conclusion: 'success',
    steps: steps(list),
  });
  const skipped = (name) => ({
    ...owner,
    name,
    conclusion: 'skipped',
    steps: [],
  });
  const candidates = ['Сборка кандидата Linux x64', 'Проверка кандидата Linux x64',
    'Сборка кандидата macOS ARM64', 'Проверка кандидата macOS ARM64', 'Выдача пары кандидатов'];

  return [
    job('План и допуск выпуска', []),
    job('Сервер, shared и руководство', names.slice(0, 1)),
    job('Web-проверки', names.slice(1, 2)),
    job('Сборка и подпись', names.slice(2)),
    job('Проверка готовых пакетов', ['Проверка готовых пакетов']),
    skipped('Публикация на сайт'),
    ...(paired ? candidates.map(skipped) : []),
  ];
}

test('reuse: обычный полный запуск нового workflow принимается по exact job attempt', async () => {
  const f = fixture();

  f.source().tree.at(-1).sha = 'c'.repeat(40);
  f.attemptJobs(classicJobs());
  assert.equal((await f.verify()).validatedCommit, prior);
});

for (const priorBlob of ['48a9468743794c93e8450336b400725e4b4d5079',
  '72167dafed76d675529dbdb1f162ac524cb48398']) {
  test('reuse: классический полный граф ' + priorBlob.slice(0, 8), async () => {
    const f = fixture();
    const jobs = classicJobs(false);

    f.source().tree.at(-1).sha = priorBlob;
    f.jobs().jobs = jobs;
    f.jobs().total_count = jobs.length;
    assert.equal((await f.verify()).validatedCommit, prior);
  });
}

for (const variant of ['candidate', 'duplicate', 'foreign-attempt', 'skipped-server']) {
  test('reuse: новый граф отклоняет ' + variant, async () => {
    const f = fixture();
    const jobs = classicJobs();

    f.source().tree.at(-1).sha = 'c'.repeat(40);

    if (variant === 'candidate') {
      jobs.at(-1).conclusion = 'success';
    } else if (variant === 'duplicate') {
      jobs.push(jobs.at(-1));
    } else if (variant === 'foreign-attempt') {
      jobs[0].run_id = 172;
    } else {
      jobs[1].conclusion = 'skipped';
      jobs[1].steps = [];
    }

    f.attemptJobs(jobs);
    await assert.rejects(f.verify(), /release_validation_/u);
  });
}

test('CLI без validation_run сохраняет полный набор и не требует GitHub token', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-validation-'));
  const output = path.join(root, 'output');
  const script = new URL('../../tools/releaseValidation.mts', import.meta.url).pathname;

  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync(process.execPath, [script], {
    env: { GITHUB_OUTPUT: output },
    timeout: 10_000,
  });
  assert.equal(await readFile(output, 'utf8'), 'reused=false\n');
});

for (const [name, mutate] of [
  ['идущий прогон', (f) => {
    f.run().status = 'in_progress';
  }],
  ['неуспешный прогон', (f) => {
    f.run().conclusion = 'failure';
  }],
  ['прогон fork', (f) => {
    f.run().head_repository.full_name = 'foreign/project';
  }],
  ['другой workflow', (f) => {
    f.run().path = 'diagnostic.yml';
  }],
  ['неизвестная версия workflow', (f) => {
    f.source().tree.at(-1).sha = '9'.repeat(40);
  }],
  ['неполная выдача jobs', (f) => {
    f.jobs().total_count = 2;
  }],
  ['сбой job', (f) => {
    f.jobs().jobs[0].conclusion = 'failure';
  }],
  ['masked failure агрегата', (f) => {
    f.jobs().jobs[0].steps[4].conclusion = 'failure';
  }],
  ['цепочка reuse с пропущенными тестами', (f) => {
    f.jobs().jobs[0].steps[0].conclusion = 'skipped';
  }],
  ['повтор имени проверки', (f) => {
    f.jobs().jobs[0].steps.push(f.jobs().jobs[0].steps[0]);
  }],
  ['изменение кода', (f) => {
    f.tree().tree[1].sha = '8'.repeat(40);
  }],
  ['изменение теста', (f) => {
    f.tree().tree[2].sha = '8'.repeat(40);
  }],
  ['изменение guide', (f) => {
    f.tree().tree[3].sha = '8'.repeat(40);
  }],
  ['изменение mode', (f) => {
    f.tree().tree[1].mode = '100755';
  }],
  ['добавленный файл продукта', (f) => {
    f.tree().tree.push({ ...f.tree().tree[1], path: 'new.ts' });
  }],
  ['удалённый файл продукта', (f) => {
    f.tree().tree.splice(1, 1);
  }],
  ['усечённое дерево', (f) => {
    f.tree().truncated = true;
  }],
  ['подмена корня дерева', (f) => {
    f.tree().sha = priorTree;
  }],
  ['symlink CI-файла', (f) => {
    f.tree().tree.at(-1).mode = '120000';
  }],
  ['другой канал', (f) => {
    f.input.channel = 'dev';
  }],
  ['ветка кроме main', (f) => {
    f.input.ref = 'refs/heads/feature';
  }],
  ['другой тег версии', (f) => {
    f.input.ref = 'refs/tags/v0.2.0';
  }],
  ['prerelease', (f) => {
    f.input.version = '0.1.0-dev.1';
  }],
  ['невалидный run', (f) => {
    f.input.runId = '../42';
  }],
]) {
  test(`reuse закрыт: ${name}`, async () => {
    const f = fixture();

    mutate(f);
    await assert.rejects(f.verify(), /release_validation_/u);
  });
}

test('reuse: stable из main принимает прежний полный прогон тех же исходников', async () => {
  const f = fixture();

  f.input.ref = 'refs/heads/main';
  assert.equal((await f.verify()).currentCommit, current);
});

test('reuse: текущий workflow допускает пропуск только публикации после проверки пакетов', async () => {
  const f = fixture();

  f.source().tree.at(-1).sha = 'c'.repeat(40);
  f.attemptJobs(classicJobs());
  assert.equal((await f.verify()).runId, 42);

  const withoutChecks = classicJobs().filter((job) => job.name !== 'Проверка готовых пакетов');

  f.attemptJobs(withoutChecks);
  await assert.rejects(f.verify(), /release_validation_jobs_incomplete/u);
});

import {
  decodePipelineReceipt, computeRecipeDigest,
} from '../../tools/releaseValidation.mts';

const repository = path.resolve(import.meta.dirname, '../..');

test('VALIDATION-PIPELINE-RECEIPT: reuse требует receipt с текущим recipeDigest', async () => {
  const stale = { format: 1, checks: { commit: 'c'.repeat(40) } };
  const recipeText = await readFile(
    path.join(repository, 'tools/releaseRecipe.json'), 'utf8');

  await assert.rejects(decodePipelineReceipt(stale, recipeText, repository),
    /pipeline_receipt_invalid/u);

  const good = {
    format: 1,
    recipeDigest: await computeRecipeDigest(recipeText, repository),
    code: 0
  };

  assert.equal((await decodePipelineReceipt(good, recipeText, repository)).recipeDigest,
    good.recipeDigest);
});

test('reuse: нативные jobs допустимы только пропущенными в новом классическом графе', async () => {
  const f = fixture();
  const jobs = classicJobs();

  f.source().tree.at(-1).sha = 'c'.repeat(40);
  jobs.at(-1).name = 'Выдача проверенных кандидатов';

  const nativeWorkflow = {
    path: '.github/workflows/grigdesk-stable-native.yml',
    type: 'blob',
    mode: '100644',
    sha: 'd'.repeat(40),
  };

  f.tree().tree.push(nativeWorkflow);
  f.source().tree.push(nativeWorkflow);

  for (const name of ['Подготовка всех стабильных загрузок', 'Стабильный пакет Android / Сборка']) {
    jobs.push({
      name,
      run_id: 42,
      head_sha: prior,
      status: 'completed',
      conclusion: 'skipped',
      steps: [],
    });
  }

  f.attemptJobs(jobs);
  assert.equal((await f.verify()).validatedCommit, prior);

  jobs.at(-1).conclusion = 'success';
  await assert.rejects(f.verify(), /release_validation_candidate_run/u);
});
