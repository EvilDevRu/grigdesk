import assert from 'node:assert/strict';
import test from 'node:test';

import { runProcess, syntheticHome } from '../tracker/helpers/processFixture.mts';
import { goCandidate } from '../helpers/goCandidate.mts';

const executable = goCandidate('routes');

test('ROUTES-LOCAL: справка, версия и лицензия доступны без сервера и токена', async (t) => {
  const { home } = await syntheticHome();
  const env = {
    HOME: home,
    PATH: '',
    GRIGDESK_HOME: '/несуществующая-папка',
    GRIGDESK_CLI_TOKEN_PATH: '/несуществующий-токен',
    GRIGDESK_BASE_URL: 'неверный адрес',
  };

  for (const flag of ['--help', '--version', '--license']) {
    const result = await runProcess(t, executable, [flag], { env });
    const output = result.stdout.toString() + result.stderr.toString();

    assert.equal(result.code, 0, output);
    assert.ok(output.length > 0);

    if (flag === '--version') {
      assert.match(result.stdout.toString(), /^routes \d+\.\d+\.\d+ \(Go go/);
      assert.equal(result.stderr.length, 0);
    }
  }

  const invalid = await runProcess(t, executable, ['несуществующая-команда'], { env });

  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr.toString(), /неизвестная команда/);
});
