import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blockReasonLabel,
  cockpitUpdateTone,
  UPDATE_STAGE_LABELS,
} from '../../web/src/shared/cockpit-update.js';

test('Cockpit update dot follows failure, checkout, release priority', () => {
  assert.equal(cockpitUpdateTone(null), '');
  assert.equal(cockpitUpdateTone({ updateAvailable: false, checkoutChanged: false, job: null }), '');
  assert.equal(cockpitUpdateTone({ updateAvailable: true, checkoutChanged: false, job: null }), 'release');
  assert.equal(cockpitUpdateTone({ updateAvailable: true, checkoutChanged: true, job: null }), 'checkout');
  assert.equal(cockpitUpdateTone({
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
