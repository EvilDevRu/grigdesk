// Хост-скрипт установки сверяет product-версию серверного ELF с жёстким ожиданием.
// Когда VERSION поднимают релизом, а ожидание в runtime-env.sh остаётся прежним,
// установка окна падает «Некорректное описание серверного ELF» уже после сборки.
// Здесь держим синхронность ожидания и VERSION репозитория.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('RUNTIME-ENV-VERSION: ожидание версии сервера совпадает с VERSION', async () => {
  const [script, version] = await Promise.all([
    readFile(`${REPO_ROOT}/deploy/lib/runtime-env.sh`, 'utf8'),
    readFile(`${REPO_ROOT}/VERSION`, 'utf8'),
  ]);

  const declared = script.match(/^GRIGDESK_EXPECTED_SERVER_VERSION=([0-9]+\.[0-9]+\.[0-9]+)$/m);
  const used = script.includes('value.get("version") != expected_version');

  assert.ok(declared, 'runtime-env.sh объявляет GRIGDESK_EXPECTED_SERVER_VERSION');
  assert.ok(used, 'проверка версии декодера пользуется объявленным ожиданием, а не литералом');
  assert.equal(declared![1], version.trim(),
    'ожидание хост-скрипта синхронно с VERSION; подними их одним заходом');
});
