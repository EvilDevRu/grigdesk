import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, closeSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, statSync,
  writeFileSync, symlinkSync, lstatSync, rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = new URL('../../', import.meta.url);

// Сервер добавляет оба каталога checkout в PATH агента.
// Состав каждого каталога проверяется отдельно, артефакты сборки остаются вне git.
const BUILT = ['factory', 'deepseek', 'grigdesk-app', 'grigdesk-server'];
const UTILITIES = ['tracker', 'pipeline', 'routes', 'voice', 'ctl', 'maintenance', 'relay'];
const RECEIPTS = {
  'deepseek.grigdesk-deepseek.json': 'DeepSeek',
  'grigdesk-server.grigdesk-server.json': 'сервера',
};
const ALLOWED = new Set([
  ...BUILT, 'utilities', 'grigdesk.png', ...Object.keys(RECEIPTS),
]);

// Команда ctl вызывает эти скрипты через exec.
// Каждый делегат должен сохранить бит исполнения.
const DELEGATED = ['deploy/desktop.sh', 'tools/mobile', 'tools/release'];

/**
 * Проверяет каталог bin: только разрешённые имена, исполняемая команда grigdesk-ctl, а
 * ELF имеет права сборки либо readonly установки DeepSeek. Квитанция не становится
 * командой агента: только обычный приватный файл; отсутствие ELF до установки штатно.
 */
function binProblems(directory: string, utilities = false): string[] {
  const names = readdirSync(directory);
  const expected = utilities ? new Set(UTILITIES) : ALLOWED;
  const problems = names.filter((name) => !expected.has(name))
    .map((name) => `лишний файл ${name}`);

  if (!utilities && names.includes('utilities')) {
    const child = path.join(directory, 'utilities');

    if (lstatSync(child).isDirectory()) {
      problems.push(...binProblems(child, true));
    } else {
      problems.push('utilities не обычный каталог');
    }
  }

  for (const name of utilities ? UTILITIES : BUILT) {
    const file = path.join(directory, name);

    if (!names.includes(name)) {
      continue;
    }

    const info = lstatSync(file);

    if (!info.isFile()) {
      problems.push(`${name} не обычный ELF`);
      continue;
    }

    const magic = Buffer.alloc(4);
    const handle = openSync(file, 'r');

    try {
      readSync(handle, magic, 0, 4, 0);
    } finally {
      closeSync(handle);
    }

    if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      problems.push(`${name} не ELF`);
    }

    const mode = info.mode & 0o777;
    const managed = ['deepseek', 'grigdesk-server'].includes(name);

    if (mode !== 0o755 && !(managed && mode === 0o555)) {
      const expected = managed ? '0755 или 0555' : '0755';

      problems.push(`${name} без прав ${expected}`);
    }
  }

  for (const [name, label] of Object.entries(RECEIPTS)) {
    if (utilities || !names.includes(name)) {
      continue;
    }

    const receipt = lstatSync(path.join(directory, name));

    if (!receipt.isFile()) {
      problems.push(`квитанция ${label} не обычный файл`);
    }

    if ((receipt.mode & 0o777) !== 0o600) {
      problems.push(`квитанция ${label} без прав 0600`);
    }
  }

  return problems;
}

test('в bin/ только команды на PATH, иконка и собранные файлы', () => {
  assert.deepEqual(binProblems(fileURLToPath(new URL('bin/', REPO))), []);
});

test('BD-ROUTES: авторинг допускается только как игнорируемый обычный ELF 0755', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'routes-bin-layout-'));
  const binary = path.join(directory, 'routes');
  const cwd = fileURLToPath(REPO);

  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.deepEqual(binProblems(directory, true), []);
  writeFileSync(binary, '#!/usr/bin/env node\n', { mode: 0o755 });
  assert.deepEqual(binProblems(directory, true), ['routes не ELF']);
  writeFileSync(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  assert.deepEqual(binProblems(directory, true), []);
  chmodSync(binary, 0o644);
  assert.deepEqual(binProblems(directory, true), ['routes без прав 0755']);
  rmSync(binary);
  symlinkSync('missing-ELF', binary);
  assert.deepEqual(binProblems(directory, true), ['routes не обычный ELF']);

  for (const relative of ['bin/utilities/routes', 'bin/utilities/.go-utilities.AB/routes']) {
    execFileSync('git', ['check-ignore', '-q', '--no-index', relative], { cwd });
    assert.equal(execFileSync('git', ['ls-files', '--', relative], { cwd }).length, 0);
  }

  writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}\n');
  assert.ok(binProblems(directory, true).includes('лишний файл package.json'));
});

test('BD-01: tracker отсутствует до сборки и допустим только как собранный ELF после неё', () => {
  // Отдельный каталог bin во временной папке: настоящий bin/ этого дерева не меняется.
  // Без аргумента tracker отсутствует, иначе записываются заданные байты и права.
  const fixture = (tracker?: { bytes: Buffer; mode: number }) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tracker-bin-layout-'));


    if (tracker) {
      writeFileSync(path.join(directory, 'tracker'), tracker.bytes);
      chmodSync(path.join(directory, 'tracker'), tracker.mode);
    }

    return directory;
  };
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);

  assert.deepEqual(binProblems(fixture(), true), []);
  assert.deepEqual(binProblems(fixture({
    bytes: elf,
    mode: 0o755,
  }), true), []);
  assert.deepEqual(binProblems(fixture({
    bytes: Buffer.from('#!/usr/bin/env bash\n'),
    mode: 0o755,
  }), true), ['tracker не ELF']);
  assert.deepEqual(binProblems(fixture({
    bytes: elf,
    mode: 0o644,
  }), true), ['tracker без прав 0755']);
});

test('BD-VOICE: команда допускает только обычный ELF 0755', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'voice-bin-layout-'));
  const binary = path.join(directory, 'voice');

  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.deepEqual(binProblems(directory, true), []);
  writeFileSync(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o644 });
  assert.deepEqual(binProblems(directory, true), ['voice без прав 0755']);
  chmodSync(binary, 0o755);
  assert.deepEqual(binProblems(directory, true), []);
  writeFileSync(binary, '#!/bin/bash\n');
  assert.deepEqual(binProblems(directory, true), ['voice не ELF']);
  rmSync(binary);
  symlinkSync('missing-ELF', binary);
  assert.deepEqual(binProblems(directory, true), ['voice не обычный ELF']);
});

test('BD-02: окно в bin/ допустимо только как ELF с правами 0755, временная копия — лишняя', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'app-bin-layout-'));
  const app = path.join(directory, 'grigdesk-app');

  assert.deepEqual(binProblems(directory), []);

  writeFileSync(app, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  chmodSync(app, 0o755);
  assert.deepEqual(binProblems(directory), []);

  chmodSync(app, 0o644);
  writeFileSync(path.join(directory, '.grigdesk-app.Ab12Cd'), '');
  assert.deepEqual(binProblems(directory),
    ['лишний файл .grigdesk-app.Ab12Cd', 'grigdesk-app без прав 0755']);
});

test('BD-03: установленный DeepSeek — ELF 0555 и только приватная обычная квитанция', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'deepseek-bin-layout-'));
  const binary = path.join(directory, 'deepseek');
  const receipt = path.join(directory, 'deepseek.grigdesk-deepseek.json');

  writeFileSync(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o555 });
  writeFileSync(receipt, '{}\n', { mode: 0o600 });
  assert.deepEqual(binProblems(directory), []);

  chmodSync(binary, 0o755);
  assert.deepEqual(binProblems(directory), []);
  chmodSync(binary, 0o777);
  assert.ok(binProblems(directory).includes('deepseek без прав 0755 или 0555'));
  chmodSync(binary, 0o555);
  chmodSync(receipt, 0o755);
  assert.ok(binProblems(directory).includes('квитанция DeepSeek без прав 0600'));

  const linked = mkdtempSync(path.join(os.tmpdir(), 'deepseek-bin-link-'));

  symlinkSync(receipt, path.join(linked, 'deepseek.grigdesk-deepseek.json'));
  assert.ok(binProblems(linked).includes('квитанция DeepSeek не обычный файл'));
  writeFileSync(path.join(linked, 'foreign.json'), '{}');
  assert.ok(binProblems(linked).includes('лишний файл foreign.json'));
});

test('BD-04: состояние установки DeepSeek игнорируется Git только по закрытым именам', () => {
  const cwd = fileURLToPath(REPO);

  for (const relative of [
    'bin/deepseek.grigdesk-deepseek.json',
    'bin/deepseek.install-lock/owner.json',
    'bin/.deepseek-install-Ab12Cd/receipt.json',
  ]) {
    execFileSync('git', ['check-ignore', '-q', '--no-index', relative], { cwd });
  }

  assert.throws(() => execFileSync('git', [
    'check-ignore', '-q', '--no-index', 'bin/foreign.json',
  ], { cwd }), { status: 1 });
});

test('BD-SERVER: ELF и private receipt допустимы, staging запрещён', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'server-bin-layout-'));
  const binary = path.join(directory, 'grigdesk-server');
  const receipt = path.join(directory, 'grigdesk-server.grigdesk-server.json');

  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o555 });
  writeFileSync(receipt, '{}\n', { mode: 0o600 });
  assert.deepEqual(binProblems(directory), []);
  chmodSync(receipt, 0o755);
  assert.ok(binProblems(directory).some((item) => item.includes('0600')));
  chmodSync(receipt, 0o600);
  writeFileSync(path.join(directory, '.grigdesk-server-install-foreign'), 'foreign');
  assert.ok(binProblems(directory).some((item) => item.includes('лишний файл')));
});

test('BD-SERVER: режимы 0755/0555, отсутствие, non-ELF и links проверяются через lstat', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'server-bin-mode-'));
  const binary = path.join(directory, 'grigdesk-server');
  const receipt = path.join(directory, 'grigdesk-server.grigdesk-server.json');

  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.deepEqual(binProblems(directory), []);
  writeFileSync(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });
  assert.deepEqual(binProblems(directory), []);
  writeFileSync(binary, '#!/bin/bash\n');
  assert.ok(binProblems(directory).some((item) => item.includes('не ELF')));
  rmSync(binary);
  symlinkSync('missing-ELF', binary);
  assert.ok(binProblems(directory).some((item) => item.includes('не обычный')));
  symlinkSync('missing-receipt', receipt);
  assert.ok(binProblems(directory).some((item) => item.includes('квитанция')));
});

test('BD-SERVER: gitignore допускает только точные имена ELF, receipt, lock и staging', () => {
  const cwd = fileURLToPath(REPO);

  for (const relative of [
    'bin/grigdesk-server',
    'bin/grigdesk-server.grigdesk-server.json',
    'bin/grigdesk-server.install-lock/owner.json',
    'bin/.grigdesk-server-install-Ab12Cd/receipt.json',
  ]) {
    execFileSync('git', ['check-ignore', '-q', '--no-index', relative], { cwd });
  }

  for (const relative of [
    'bin/foreign.json', 'bin/grigdesk-server-foreign', 'bin/.server-install-foreign/x',
  ]) {
    assert.throws(() => execFileSync('git', ['check-ignore', '-q', '--no-index', relative], { cwd }), {
      status: 1,
    });
  }
});

test('иконка ярлыка совпадает с иконкой интерфейса', () => {
  const icon = readFileSync(new URL('bin/grigdesk.png', REPO));
  const web = readFileSync(new URL('web/public/icon-512.png', REPO));

  assert.ok(icon.equals(web), 'bin/grigdesk.png — копия web/public/icon-512.png');
});

test('BD-GO-CTL: отсутствие сборки допустимо, Bash по пути Go CLI отклоняется', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'go-ctl-bin-layout-'));

  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.deepEqual(binProblems(directory, true), []);
  writeFileSync(path.join(directory, 'ctl'), '#!/bin/bash\n', { mode: 0o755 });
  assert.deepEqual(binProblems(directory, true), ['ctl не ELF']);

  for (const file of DELEGATED) {
    assert.ok(statSync(new URL(file, REPO)).mode & 0o111, `${file} исполняемый`);
  }
});
