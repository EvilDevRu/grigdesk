import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, statSync,
  writeFileSync, symlinkSync, lstatSync, rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = new URL('../../', import.meta.url);

// Сервер кладёт bin/ первым в PATH каждого агента (server/src/lib/cliPath.ts), поэтому любой
// исполняемый файл здесь становится командой агента по голому имени. Набор закрыт: единая
// команда, иконка ярлыка и собранные файлы (b24, посредник и установленное окно), которые в git
// не попадают.
const COMMANDS = ['grigdesk-ctl'];
const BUILT = ['b24', 'deepseek', 'grigdesk-relay', 'grigdesk-app', 'grigdesk-server'];
const RECEIPTS = {
  'deepseek.grigdesk-deepseek.json': 'DeepSeek',
  'grigdesk-server.grigdesk-server.json': 'сервера',
};
const ALLOWED = new Set([...COMMANDS, ...BUILT, 'grigdesk.png', ...Object.keys(RECEIPTS)]);

// ELF сборки имеет 0755; установленный DeepSeek публикуется без записи, с правами 0555.
const ELF_BUILT = ['b24', 'deepseek', 'grigdesk-app', 'grigdesk-server'];

// Скрипты, которым bin/grigdesk-ctl передаёт `desktop`, `mobile` и `release`. Им нужен
// бит исполнения: команда зовёт их через exec, а не через bash. b24 — собранный файл или исходник.
const DELEGATED = ['deploy/desktop.sh', 'tools/mobile', 'tools/release'];

/**
 * Проверяет каталог bin: только разрешённые имена, исполняемая команда grigdesk-ctl, а
 * ELF имеет права сборки либо readonly установки DeepSeek. Квитанция не становится
 * командой агента: только обычный приватный файл; отсутствие ELF до установки штатно.
 */
function binProblems(directory: string): string[] {
  const problems = readdirSync(directory).filter((name) => !ALLOWED.has(name))
    .map((name) => `лишний файл ${name}`);

  for (const name of COMMANDS) {
    if (!(statSync(path.join(directory, name)).mode & 0o111)) {
      problems.push(`${name} не исполняемый`);
    }
  }

  for (const name of ELF_BUILT) {
    const file = path.join(directory, name);

    if (!readdirSync(directory).includes(name)) {
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
    if (!readdirSync(directory).includes(name)) {
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

test('BD-01: b24 отсутствует до сборки и допустим только как собранный ELF после неё', () => {
  // Отдельный каталог bin во временной папке: настоящий bin/ этого дерева не меняется.
  // Без аргумента b24 отсутствует, иначе записываются заданные байты и права.
  const fixture = (b24?: { bytes: Buffer; mode: number }) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'b24-bin-layout-'));

    writeFileSync(path.join(directory, 'grigdesk-ctl'), '#!/bin/bash\n', { mode: 0o755 });

    if (b24) {
      writeFileSync(path.join(directory, 'b24'), b24.bytes);
      chmodSync(path.join(directory, 'b24'), b24.mode);
    }

    return directory;
  };
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);

  assert.deepEqual(binProblems(fixture()), []);
  assert.deepEqual(binProblems(fixture({
    bytes: elf,
    mode: 0o755,
  })), []);
  assert.deepEqual(binProblems(fixture({
    bytes: Buffer.from('#!/usr/bin/env bash\n'),
    mode: 0o755,
  })), ['b24 не ELF']);
  assert.deepEqual(binProblems(fixture({
    bytes: elf,
    mode: 0o644,
  })), ['b24 без прав 0755']);
});

test('BD-02: окно в bin/ допустимо только как ELF с правами 0755, временная копия — лишняя', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'app-bin-layout-'));
  const app = path.join(directory, 'grigdesk-app');

  writeFileSync(path.join(directory, 'grigdesk-ctl'), '#!/bin/bash\n', { mode: 0o755 });
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

  writeFileSync(path.join(directory, 'grigdesk-ctl'), '#!/bin/bash\n', { mode: 0o755 });
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

  writeFileSync(path.join(linked, 'grigdesk-ctl'), '#!/bin/bash\n', { mode: 0o755 });
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
  writeFileSync(path.join(directory, 'grigdesk-ctl'), '#!/bin/bash\n', { mode: 0o755 });
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
  writeFileSync(path.join(directory, 'grigdesk-ctl'), '#!/bin/bash\n', { mode: 0o755 });
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

test('bin/grigdesk-ctl передаёт команды существующим исполняемым скриптам', () => {
  const dispatcher = readFileSync(new URL('bin/grigdesk-ctl', REPO), 'utf8');

  assert.match(dispatcher, /exec "\$DIR\/deploy\/desktop\.sh"/);
  assert.match(dispatcher, /if \[\[ -x "\$DIR\/bin\/b24" \]\]; then\n\s+exec "\$DIR\/bin\/b24" "\$@"/);
  assert.match(dispatcher, /exec node "\$DIR\/b24\/src\/main\.ts" "\$@"/);
  assert.match(dispatcher, /mobile\|release\)\n\s+shift\n\s+exec "\$DIR\/tools\/\$CMD"/);
  assert.ok(existsSync(new URL('b24/src/main.ts', REPO)), 'исходник b24 для запуска без сборки');

  for (const file of DELEGATED) {
    assert.ok(statSync(new URL(file, REPO)).mode & 0o111, `${file} исполняемый`);
  }
});

// cli/ — только TypeScript единой команды. Shell-скрипты живут по назначению: установка и
// запуск — в deploy/, общие bash-функции — в deploy/lib/, инструменты разработчика — в tools/.
test('в cli/ только TypeScript единой команды', () => {
  const extra = readdirSync(new URL('cli/', REPO))
    .filter((name) => !name.endsWith('.ts') && name !== 'package.json');

  assert.deepEqual(extra, []);
});
