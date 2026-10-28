import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { assertNoExternalCliProcess } from '../../server/src/lib/providerInstall/externalProcesses.ts';

/**
 * Псевдо-процессы проверяют разбор /proc без чужих живых процессов.
 * Недоступный exe не доказывает занятость, недоступный cmdline закрывает запись.
 */
function fakeProc(entries, options = {}) {
  return {
    async readdir() {
      return Object.keys(entries);
    },
    async stat(directory) {
      const entry = entries[path.basename(directory)];

      if (!entry) {
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      }

      return { uid: entry.uid ?? process.getuid() };
    },
    async readFile(file) {
      const entry = entries[path.basename(path.dirname(file))];

      if (entry?.cmdlineError) {
        throw Object.assign(new Error(entry.cmdlineError), { code: entry.cmdlineError });
      }

      return (entry?.cmdline ?? []).join('\0');
    },
    async readlink(file) {
      const entry = entries[path.basename(path.dirname(file))];

      if (entry?.exeError) {
        throw Object.assign(new Error(entry.exeError), { code: entry.exeError });
      }

      return entry?.exe ?? '';
    },
    ...options,
  };
}

test('процесс выбранной копии запрещает обслуживание', async () => {
  const root = '/home/fixture/prefix/lib/node_modules/@fixture/cli';

  await assert.rejects(assertNoExternalCliProcess(root, ['/home/fixture/prefix/bin/fixture'],
    fakeProc({ 501: { exe: `${root}/cli.js`, cmdline: [root, '--serve'] } }, {
      readdir: async () => ['501'],
    })),
  { code: 'provider_in_use' });
});

test('exe без прав чтения не считается доказательством занятости', async () => {
  const root = '/home/fixture/prefix/lib/node_modules/@fixture/cli';
  const result = assertNoExternalCliProcess(root, [], fakeProc({
    501: { exeError: 'EACCES', cmdline: ['/usr/bin/chrome_crashpad_handler', '--database=/tmp/db'] },
  }));

  await result;
});

test('нечитаемая командная строка закрывает обслуживание', async () => {
  const root = '/home/fixture/prefix/lib/node_modules/@fixture/cli';

  await assert.rejects(assertNoExternalCliProcess(root, [], fakeProc({
    501: { cmdlineError: 'EACCES' },
  })), { code: 'process_state_unknown' });
});

test('чужой uid и исчезнувший процесс не блокируют обслуживание', async () => {
  const root = '/home/fixture/prefix/lib/node_modules/@fixture/cli';

  await assertNoExternalCliProcess(root, [], fakeProc({
    501: {
      uid: 0,
      exe: `${root}/cli.js`,
      cmdline: [root],
    },
    502: { exe: `${root}/cli.js`, cmdline: [root] },
  }, {
    readdir: async () => ['501', '502'],
    stat: async (directory) => {
      if (directory.endsWith('/502')) {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }

      return { uid: 0 };
    },
  }));
});
