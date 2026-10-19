import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

test('устройства модала: поля поиска, черновик открытия и явная выдача кода', async (t) => {
  const h = await settingsHarness(t, 'connections.devices', 'DevicesPage', {
    prepare({ control }) {
      control.handlers['/api/devices'] = () => new Response(JSON.stringify({
        listener: { state: 'online', addresses: [] },
        devices: [],
      }));
      control.handlers['/api/devices/pairing'] = () => new Response(JSON.stringify({
        text: 'synthetic',
        svg: '<svg/>',
        expiresInMs: 600000,

      }));
    },
  });
  const fields = h.wrapper.findAll('input');

  assert.equal(fields.length, 2);
  await fields[0].setValue('Планшет');
  await fields[1].setValue('desk.example:8145');
  assert.equal(h.writes().length, 0);
  h.settings.selectPage('connections.b24');
  h.settings.selectPage('connections.devices');

  const draft = h.settings.sessionService('devicePairing', () => null);

  assert.equal(draft.name, 'Планшет');
  assert.equal(draft.address, 'desk.example:8145');
  h.settings.reveal({ pageId: 'connections.devices', fieldPath: ['address'] });
  await h.flushPromises();
  assert.equal(document.activeElement === fields[1].element, true);
  h.settings.dispose();
  h.settings.requestOpen({ pageId: 'connections.devices' });
  assert.equal(h.settings.sessionService('devicePairing', () => 'new-opening'), 'new-opening');
});
