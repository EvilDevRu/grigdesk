import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CodeContractError,
  parseCodeBlame,
  parseCodeRoots,
  parseCodeSearch,
  parseCodeDiffSummary,
  parseCodeCommitSearch,
  parseCodeQuickOpen,
  parseCodeRepos,
  parseCodeProjects,
  parseCodeDirectory,
  parseCodeFile,
  parseCodeFileDiff,
  parseCodeFileLog,
  parseCodeGit,
  parseCodePatch,
  parseCodeCommitsDiff,
  parseCodeStageResponse,
  parseCodeCommitResponse,
  parseCodeFetchResponse,
  parseCodePushResponse,
  parseCodeUndoCommitResponse,
  parseCodeCommitTitleResponse,
} from '../../shared/plugins/code/codeContracts.ts';
import { api } from '../../web/src/shared/apiClient.ts';
import { codeApi, codeErrorMessage } from '../../web/src/shared/codeApi.ts';
import { codeRoots, loadCodeRoots } from '../../web/src/features/code/links.ts';

const tracking = { detached: false, upstream: '', ahead: 0, behind: 0 };
const file = {
  path: 'src/demo.ts', status: 'M', add: 1, del: 0,
  binary: false,
};
const fileDiff = {
  path: 'src/demo.ts', status: 'M', binary: false, tooBig: false,
  oldContent: '', newContent: 'export {};',
};
const root = { project: 'demo', repo: 'main', root: '/repo', main: true, branch: 'main' };
const tree = { path: '/repo', main: true, name: 'repo', task: '', branch: 'main' };
const git = { branch: 'main', stat: '', files: [file], staged: [], tracking, log: [], headMessage: '' };
const commitsDiff = {
  branch: 'main',
  stat: ' src/demo.ts | 1 +',
  files: [file],
  range: { from: 'a'.repeat(40), to: 'b'.repeat(40), base: 'c'.repeat(40), commits: 1, work: false },
};
const contracts = [
  [parseCodeRoots, { roots: [root] }],
  [parseCodeRepos, { repos: [{ key: 'main', dir: '/repo', trees: [tree] }] }],
  [parseCodeProjects, {
    projects: [{ id: 'demo', repos: [{ key: 'main', dir: '/repo' }], archivedAt: null }],
  }],
  [parseCodeDirectory, { entries: [{ name: 'src', dir: true }] }],
  [parseCodeFile, { size: 10, binary: false, tooBig: false, content: 'export {};' }],
  [parseCodeGit, git],
  [parseCodePatch, { patch: 'diff --git a/a b/a\n', truncated: false }],
  [parseCodeFileDiff, fileDiff],
  [parseCodeFileLog, { entries: [{
    hash: 'a'.repeat(40), base: 'b'.repeat(40), subject: 'Изменение',
    when: 'сейчас', path: 'src/demo.ts',
  }] }],
  [parseCodeBlame, { lines: [{
    line: 1, hash: 'a'.repeat(40), base: 'b'.repeat(40), author: 'Анна',
    when: 'сейчас', subject: 'Изменение',
  }] }],
  [parseCodeSearch, {
    files: [{ path: 'src/demo.ts' }],
    matches: [{ path: 'src/demo.ts', line: 2, text: 'demo' }],
    truncated: false,
  }],
  [parseCodeCommitsDiff, commitsDiff],
  [parseCodeStageResponse, { ok: true, changed: 1 }],
  [parseCodeCommitResponse, { ok: true, hash: 'abc123', subject: 'Изменение' }],
  [parseCodePushResponse, { ok: true, branch: 'main', remote: 'origin', published: false, tracking }],
  [parseCodeFetchResponse, { ok: true, remote: 'origin', tracking }],
  [parseCodeUndoCommitResponse, { ok: true, message: 'Предыдущее сообщение' }],
  [parseCodeCommitTitleResponse, { ok: true, title: 'Изменение', model: 'test/demo', effort: null, truncated: false }],
];

test('контракты чтения и действий принимают JSON и отбрасывают посторонние поля', () => {
  for (const [parse, payload] of contracts) {
    assert.deepEqual(parse({ ...payload, ignored: 'лишнее поле' }), payload);
    for (const invalid of [null, [], 'text', 12, false, {}]) {
      assert.throws(() => parse(invalid), CodeContractError);
    }
  }
  assert.deepEqual(parseCodeGit({ ...git, files: [{ ...file, group: 'staged', oldPath: 'old.ts' }] }).files,
    [{ ...file, group: 'staged', oldPath: 'old.ts' }]);
  assert.equal('oldPath' in parseCodeGit(git).files[0], false);
  assert.equal(parseCodeGit({ ...git, tracking: { ...tracking, remote: 'origin' } }).tracking.remote,
    'origin');
});

test('повреждённый элемент отклоняет весь ответ до обновления состояния', () => {
  assert.throws(() => parseCodeGit({ ...git, files: [file, { ...file, add: '1' }] }), /git\.files\[1\]\.add/);
  assert.throws(() => parseCodeFileDiff({ ...fileDiff, tooBig: 'да' }), /fileDiff\.tooBig/);
  assert.throws(() => parseCodeCommitsDiff({ ...commitsDiff, range: undefined }), /commitsDiff\.range/);
  // «С текущими изменениями» — часть контракта: без флага клиент не знает, куда слать file-diff.
  assert.throws(() => parseCodeCommitsDiff({
    ...commitsDiff,
    range: { ...commitsDiff.range, work: undefined },
  }), /range\.work/);
  assert.throws(() => parseCodeCommitsDiff({
    ...commitsDiff,
    range: { ...commitsDiff.range, work: '1' },
  }), /range\.work/);
  assert.throws(() => parseCodeCommitsDiff({
    ...commitsDiff,
    range: { ...commitsDiff.range, commits: '1' },
  }), /commitsDiff\.range\.commits/);
  assert.throws(() => parseCodeGit({ ...git, tracking: { ...tracking, ahead: Infinity } }), /tracking\.ahead/);
  for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseCodeGit({ ...git, files: [{ ...file, add: invalid }] }), /files\[0\]\.add/);
    assert.throws(() => parseCodeFile({ size: invalid, binary: false, tooBig: false, content: '' }), /file\.size/);
  }
  assert.throws(() => parseCodeGit({ ...git, files: [{ ...file, group: 'all' }] }), /files\[0\]\.group/);
  assert.throws(() => parseCodeRepos({ repos: [{ key: 'main', dir: '/repo', trees: [tree, null] }] }),
    /repos\[0\]\.trees\[1\]/);
  assert.throws(() => parseCodeDirectory({ entries: [{ name: 'file', dir: 'false' }] }), /entries\[0\]\.dir/);
  assert.throws(() => parseCodeStageResponse({ ok: false, changed: 1 }), /stage\.ok/);
});

test('ошибка контракта показывает путь поля без отклонённого значения', () => {
  try {
    parseCodeFile({ size: 'непубликуемое значение', binary: false, tooBig: false, content: '' });
    assert.fail('Ожидалась ошибка контракта');
  } catch (error) {
    assert.ok(error instanceof CodeContractError);
    assert.match(error.message, /file\.size/);
    assert.doesNotMatch(error.message, /непубликуемое/);
  }
  assert.equal(codeErrorMessage({ data: { message: 'Ответ сервера' }, message: 'Транспорт' }), 'Ответ сервера');
  assert.equal(codeErrorMessage(null, 'Запасной текст'), 'Запасной текст');
  assert.equal(codeErrorMessage({ data: { message: [] }, message: 'Транспорт' }), 'Транспорт');
});

test('адаптер кодирует контекст и передаёт только выбранные пути без преобразования', async (t) => {
  const context = { project: 'demo x', repoKey: 'main+api', treePath: '/repo пробел&query' };
  const selection = { paths: [':(glob)*.txt', 'src/русский.ts'] };
  const seen = [];
  t.mock.method(api, 'post', async (url, body) => {
    seen.push({ url, body });
    return { ok: true, changed: 2 };
  });
  t.mock.method(api, 'get', async (url) => {
    seen.push({ url });
    return { size: 1, binary: false, tooBig: false, content: 'x' };
  });
  assert.deepEqual(await codeApi.stage(context, selection), { ok: true, changed: 2 });
  assert.deepEqual(await codeApi.unstage(context, selection), { ok: true, changed: 2 });
  await codeApi.file(context, 'src/a&b.ts');
  for (const request of seen) {
    const url = new URL(request.url, 'http://example.test');
    assert.ok(url.pathname.startsWith('/api/code/demo%20x/'));
    assert.equal(url.searchParams.get('repo'), context.repoKey);
    assert.equal(url.searchParams.get('root'), context.treePath);
  }
  assert.deepEqual(seen[0].body, selection);
  assert.equal(new URL(seen[2].url, 'http://example.test').searchParams.get('path'), 'src/a&b.ts');
});

test('адаптер не выдаёт повреждённый HTTP JSON за успешный результат', async (t) => {
  const context = { project: 'demo', repoKey: 'main', treePath: '/repo' };
  t.mock.method(api, 'get', async () => ({ ...git, staged: null }));
  t.mock.method(api, 'post', async () => ({ ok: true }));
  await assert.rejects(codeApi.git(context), CodeContractError);
  await assert.rejects(codeApi.commit(context, 'Название'), CodeContractError);
  await assert.rejects(codeApi.push(context), CodeContractError);
  await assert.rejects(codeApi.fetch(context), CodeContractError);
  await assert.rejects(codeApi.undoCommit(context), CodeContractError);
  await assert.rejects(codeApi.commitMessage(context), CodeContractError);
});

test('карта файловых ссылок сохраняет последний корректный ответ при повреждённом JSON', async (t) => {
  let reply = { roots: [root] };
  let count = 0;
  t.mock.method(api, 'get', async () => { count += 1; return reply; });
  assert.deepEqual(await loadCodeRoots({ force: true }), [root]);
  reply = { roots: [root, { ...root, root: null }] };
  const first = loadCodeRoots({ force: true });
  const second = loadCodeRoots({ force: true });
  assert.equal(first, second);
  assert.deepEqual(await first, [root]);
  assert.deepEqual(codeRoots.value, [root]);
  assert.deepEqual(await loadCodeRoots(), [root]);
  assert.equal(count, 2);
});

test('CODE-FP-CONTRACT: fingerprint optional, повреждённое поле отклоняет весь ответ', () => {
  assert.deepEqual(parseCodeFileDiff(fileDiff), fileDiff);

  const fingerprint = 'a'.repeat(64);

  assert.equal(parseCodeFileDiff({ ...fileDiff, fingerprint }).fingerprint, fingerprint);

  for (const invalid of [null, 12, {}, '', 'bad-hash']) {
    assert.throws(() => parseCodeFileDiff({ ...fileDiff, fingerprint: invalid }), CodeContractError);
  }
});

for (const [method, options] of [
  ['reviewFingerprints', { comparisons: [{ group: 'work', path: 'a.txt' }] }],
  ['conflict', 'a.txt'],
  ['partialDiff', { group: 'work', path: 'a.txt' }],
  ['partialIndex', {
    group: 'work',
    path: 'a.txt',
    token: 'token',
    atomIds: ['raw-C'],
  }],
  ['actionPreview', {
    action: 'stage',
    group: 'work',
    paths: ['a.txt'],
  }],
  ['actionExecute', {
    action: 'stage',
    group: 'work',
    paths: ['a.txt'],
    token: 'token',
  }],
  ['ignorePreview', { target: 'local', paths: ['a.txt'] }],
  ['ignore', {
    target: 'local',
    paths: ['a.txt'],
    token: 'token',
  }],
]) {
  test(`CODE-REVIEW-CONTRACT: ${method} не принимает повреждённый HTTP JSON`, async (t) => {
    const context = {
      project: 'demo',
      repoKey: 'main',
      treePath: '/repo',
    };

    assert.equal(typeof codeApi[method], 'function', `Нет публичного адаптера ${method}`);
    t.mock.method(api, 'get', async () => null);
    t.mock.method(api, 'post', async () => null);
    await assert.rejects(codeApi[method](context, options), CodeContractError);
  });
}

test('parseCodeQuickOpen: принимает список строк и отвергает повреждённые пути', () => {
  assert.deepEqual(parseCodeQuickOpen({ files: ['a.ts', 'b.md'] }), { files: ['a.ts', 'b.md'] });
  assert.throws(() => parseCodeQuickOpen({ files: 'a.ts' }), CodeContractError);
  assert.throws(() => parseCodeQuickOpen({ files: [1] }), CodeContractError);
});

test('commit-search decoder: снимок, позиции, лимит и неверные поля', () => {
  const value = {
    head: 'a'.repeat(40),
    log: [{
      hash: 'bbbb',
      oid: 'b'.repeat(40),
      subject: 'old result',
      when: 'now',
      ordinal: 75,
    }],
  };

  assert.deepEqual(parseCodeCommitSearch(value), value);
  assert.deepEqual(parseCodeCommitSearch({ head: '', log: [] }), { head: '', log: [] });

  for (const invalid of [
    { ...value, head: 'short' },
    { ...value, log: [{ ...value.log[0], ordinal: 200 }] },
    { ...value, log: [{ ...value.log[0], ordinal: 1.5 }] },
    { ...value, log: [{ ...value.log[0], hash: 3 }] },
    { ...value, log: [{ ...value.log[0], oid: 'c'.repeat(40) }] },
    { ...value, log: [value.log[0], value.log[0]] },
    { head: '', log: value.log },
  ]) {
    assert.throws(() => parseCodeCommitSearch(invalid), CodeContractError);
  }
});

test('blame sourcePath: отсутствие, null и исторический путь имеют разный смысл', () => {
  const line = {
    line: 1,
    hash: 'a'.repeat(40),
    base: 'b'.repeat(40),
    author: 'Автор',
    when: 'сейчас',
    subject: 'Исходная правка',
  };

  assert.deepEqual(parseCodeBlame({ lines: [line] }), { lines: [line] });

  for (const sourcePath of [null, 'source "quoted".js']) {
    assert.deepEqual(parseCodeBlame({ lines: [{ ...line, sourcePath }] }), {
      lines: [{ ...line, sourcePath }],
    });
  }
  for (const sourcePath of ['', 4, '/outside', '../outside', 'a/../b', 'a\0b']) {
    assert.throws(() => parseCodeBlame({ lines: [{ ...line, sourcePath }] }), CodeContractError);
  }
});

test('parseCodeDiffSummary: успешный DTO и границы строки', () => {
  assert.deepEqual(parseCodeDiffSummary({ ok: true, summary: 'ок' }), { ok: true, summary: 'ок' });

  for (const value of [
    { ok: true, summary: '' },
    { ok: true, summary: '   ' },
    { ok: true, summary: 'x'.repeat(501) },
    { ok: false, summary: 'ок' },
    { summary: 'ок' },
    'ок',
  ]) {
    assert.throws(() => parseCodeDiffSummary(value), CodeContractError);
  }
});
