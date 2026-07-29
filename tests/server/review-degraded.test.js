import assert from 'node:assert/strict';
import test from 'node:test';

import { createDegradedReviewService } from '../../server/src/lib/reviews/degraded.js';

test('READY-01: сбой review init даёт fail-closed facade, не требующий остановки Cockpit', async () => {
  const cause = new Error('control state повреждён');
  cause.code = 'REVIEW_CONTROL_CORRUPT';
  const reviews = createDegradedReviewService(cause);

  assert.equal(reviews.degraded, true);
  await assert.rejects(
    reviews.snapshot(),
    (error) => error.code === 'REVIEW_SUBSYSTEM_UNAVAILABLE' && error.statusCode === 503,
  );
  await assert.rejects(
    reviews.assertRepositoryMutable('demo', 'app'),
    (error) => error.code === 'REVIEW_SUBSYSTEM_UNAVAILABLE',
  );
  await reviews.close();
});
