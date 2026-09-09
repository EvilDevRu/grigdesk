import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  entrypointsWithTypeScript,
  TYPE_STRIPPING_LAUNCHERS,
} from '../../tools/entrypointGraph.mts';

async function source(path: string): Promise<string> {
  return readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
}

/**
 * Дочерний процесс не наследует флаги родителя, а минимальная поддерживаемая версия
 * Node ещё не снимает типы сама. Программа, чей граф дошёл до TypeScript, обязана
 * получать флаг явно — иначе она не стартует у того, кто держит минимум, и отказ
 * будет выглядеть чем угодно, только не поломкой запуска.
 */
test('каждая точка входа с TypeScript в графе названа вместе со своим запуском', () => {
  assert.deepEqual(
    entrypointsWithTypeScript(),
    Object.keys(TYPE_STRIPPING_LAUNCHERS).sort(),
  );
});

test('shell-лаунчеры передают снятие типов, а не полагаются на версию Node', async () => {
  const [runtimeEnv, cockpit, restart, install, unit, knowledge] = await Promise.all([
    source('bin/lib/runtime-env.sh'),
    source('bin/cockpit'),
    source('bin/restart'),
    source('deploy/install.sh'),
    source('deploy/cockpit-server.service'),
    source('bin/knowledge'),
  ]);

  assert.match(runtimeEnv, /COCKPIT_NODE_TS_ARGS=\(.*--experimental-strip-types\)/);

  // Preflight поиска импортирует TypeScript, а его отказ везде гасится `|| true`:
  // пропущенный флаг выглядел бы не поломкой, а «поиск недоступен».
  for (const [name, text] of [['bin/cockpit', cockpit], ['bin/restart', restart],
    ['deploy/install.sh', install], ['bin/knowledge', knowledge]] as const) {
    assert.match(text, /COCKPIT_NODE_TS_ARGS\[@\]/, name);
  }

  for (const line of unit.split('\n').filter((row) => row.startsWith('ExecStart'))) {
    if (line.includes('server/')) {
      assert.match(line, /--experimental-strip-types/, line);
    }
  }
});
