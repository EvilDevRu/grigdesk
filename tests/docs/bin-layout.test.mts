import assert from 'node:assert/strict';
import {
  chmodSync, closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = new URL('../../', import.meta.url);

// Сервер кладёт bin/ первым в PATH каждого агента (server/src/lib/cliPath.ts), поэтому любой
// исполняемый файл здесь становится командой агента по голому имени. Набор закрыт: единая
// команда, иконка ярлыка и два собранных файла (b24 и посредник), которые в git не попадают.
const COMMANDS = ['cockpit'];
const BUILT = ['b24', 'cockpit-relay'];
const ALLOWED = new Set([...COMMANDS, ...BUILT, 'cockpit.png']);

// Скрипты, которым bin/cockpit передаёт `desktop`, `mobile` и `release`. Им нужен
// бит исполнения: команда зовёт их через exec, а не через bash. b24 — собранный файл или исходник.
const DELEGATED = ['deploy/desktop.sh', 'tools/mobile', 'tools/release'];

/**
 * Проверяет каталог bin: только разрешённые имена, исполняемая команда cockpit и
 * собранный b24 — только ELF с правами 0755. Отсутствие b24 до сборки — штатно.
 */
function binProblems(directory: string): string[] {
  const problems = readdirSync(directory).filter((name) => !ALLOWED.has(name))
    .map((name) => `лишний файл ${name}`);

  for (const name of COMMANDS) {
    if (!(statSync(path.join(directory, name)).mode & 0o111)) {
      problems.push(`${name} не исполняемый`);
    }
  }

  const b24 = path.join(directory, 'b24');

  if (existsSync(b24)) {
    const magic = Buffer.alloc(4);
    const handle = openSync(b24, 'r');

    try {
      readSync(handle, magic, 0, 4, 0);
    } finally {
      closeSync(handle);
    }

    if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      problems.push('b24 не ELF');
    }

    if ((statSync(b24).mode & 0o777) !== 0o755) {
      problems.push('b24 без прав 0755');
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

    writeFileSync(path.join(directory, 'cockpit'), '#!/bin/bash\n', { mode: 0o755 });

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

test('иконка ярлыка совпадает с иконкой интерфейса', () => {
  const icon = readFileSync(new URL('bin/cockpit.png', REPO));
  const web = readFileSync(new URL('web/public/icon-512.png', REPO));

  assert.ok(icon.equals(web), 'bin/cockpit.png — копия web/public/icon-512.png');
});

test('bin/cockpit передаёт команды существующим исполняемым скриптам', () => {
  const dispatcher = readFileSync(new URL('bin/cockpit', REPO), 'utf8');

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
