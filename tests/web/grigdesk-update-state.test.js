import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blockReasonLabel,
  grigDeskUpdateTone,
  UPDATE_STAGE_LABELS,
} from '../../web/src/shared/grigdesk-update.js';

test('GrigDesk update dot follows failure, checkout, release priority', () => {
  assert.equal(grigDeskUpdateTone(null), '');
  assert.equal(grigDeskUpdateTone({ updateAvailable: false, checkoutChanged: false, job: null }), '');
  assert.equal(grigDeskUpdateTone({ updateAvailable: true, checkoutChanged: false, job: null }), 'release');
  assert.equal(grigDeskUpdateTone({ updateAvailable: true, checkoutChanged: true, job: null }), 'checkout');
  assert.equal(grigDeskUpdateTone({
    updateAvailable: true, checkoutChanged: true, job: { status: 'failed' },
  }), 'error');
});

test('disabled update reasons and persisted stages always have readable labels', () => {
  for (const reason of ['working_tree_dirty', 'branch_not_main', 'checkout_diverged', 'update_in_progress']) {
    assert.doesNotMatch(blockReasonLabel(reason), /undefined|\[object/);
  }
  for (const stage of ['queued', 'preparing', 'installing', 'building', 'testing', 'applying', 'restarting', 'done', 'failed']) {
    assert.equal(typeof UPDATE_STAGE_LABELS[stage], 'string');
    assert.ok(UPDATE_STAGE_LABELS[stage].length > 5);
  }
});
