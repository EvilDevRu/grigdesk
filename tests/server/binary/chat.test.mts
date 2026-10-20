import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { isolatedBinary } from './isolation.mts';

const RUN = path.resolve(import.meta.dirname, '../../../..');

for (const installationPath of ['/I', '/I with spaces']) {
  test(`SB25-CHAT: настоящие compiled chat turns без source, I=${installationPath}`, {
    timeout: 360000,
  }, async (t) => {
    const candidate = process.env.GRIGDESK_TEST_SERVER_BINARY;
    const deepseekBinary = process.env.GRIGDESK_TEST_DEEPSEEK_BINARY;

    assert.ok(candidate, 'Нужен явный GRIGDESK_TEST_SERVER_BINARY');
    assert.ok(deepseekBinary, 'Нужен явный GRIGDESK_TEST_DEEPSEEK_BINARY');

    const built = JSON.parse(await readFile(path.join(RUN, 'release/build-result.json'), 'utf8'));
    const sha256 = createHash('sha256').update(await readFile(candidate)).digest('hex');

    assert.equal(sha256, built.sha256, 'S25 требует финальный candidate SHA из build-result.json');

    const fixture = await isolatedBinary(t, {
      candidate,
      deepseekBinary,
      installationPath,
    });
    const report = await fixture.run(path.join(import.meta.dirname, 'drivers/chat.mts'));
    const suffix = installationPath.includes(' ') ? '-spaces' : '';

    await writeFile(path.join(RUN, `s25-chat${suffix}.json`), JSON.stringify({
      sha256,
      packageId: fixture.paths.packageId,
      ...report,
    }, null, 2));

    assert.deepEqual(report.providers, ['deepseek', 'glm'], 'Оба compiled adapter должны завершить ходы');
    assert.equal(report.api.authenticated, true);
    assert.equal(report.api.windowSession, true);
    assert.equal(report.deepseek.reply, 'S25-DEEPSEEK-REPLY');
    assert.equal(report.glm.reply, 'S25-GLM-REPLY');
    assert.equal(report.integrity.unchanged, true);
    assert.equal(report.hostNodeAttempts, 0);
  });
}
