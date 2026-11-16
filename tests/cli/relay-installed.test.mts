import assert from 'node:assert/strict';
import test from 'node:test';

import { relayCliFixture } from './helpers/relayDeployment.mts';
import { assertRestored } from './helpers/pty.mts';

for (const action of ['setup', 'restore']) {
  test(`RD-CTL-04: installed helper открывает общий relay ${action} из receipt.dataHome`, async (t) => {
    const h = await relayCliFixture(t, true);
    const terminal = h.launch(action);

    await terminal.wait(action === 'setup'
      ? /имя.*(?:доступ|подключ)|(?:доступ|подключ).*имя/iu
      : /Прежний доступ|восстанов/iu);
    assert.doesNotMatch(terminal.output(), /maintenance_action_unavailable/u);
    terminal.write('\x03');

    const result = await terminal.done;

    assert.equal(result.code, 130, terminal.output());
    assertRestored(result, terminal.output());
    assert.equal(h.box.calls().some((call) => call.startsWith('docker ')), false);
  });
}
