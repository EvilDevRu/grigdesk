// Проверяет, что установленная версия Kimi поддерживает зафиксированный контракт ACP.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/kimi-acp-tool-lifecycle.json', import.meta.url),
  'utf8',
));

test('установленная версия Kimi покрыта проверенным ACP lifecycle fixture', async (t) => {
  const binary = process.env.GRIGDESK_KIMI_BIN?.trim() || 'kimi';
  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
    }));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      t.skip(`Kimi binary не найден: ${binary}`);
      return;
    }
    throw error;
  }

  const versionOutput = `${stdout || ''}\n${stderr || ''}`.trim();
  const installedVersion = versionOutput.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0];
  assert.ok(installedVersion, `не удалось разобрать версию из вывода ${binary} --version: ${versionOutput}`);
  assert.ok(
    fixture.verifiedVersions.includes(installedVersion),
    `Kimi ${installedVersion} ещё не проверен: переснимите ACP lifecycle fixture и добавьте версию в verifiedVersions`,
  );
});
