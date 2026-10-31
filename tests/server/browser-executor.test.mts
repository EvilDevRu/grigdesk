import assert from 'node:assert/strict';
import test from 'node:test';
import { codexDynamicToolResponse } from '../../server/src/lib/executors/codex.ts';

test('BR15-I: screenshot становится inputImage без JSON/base64 в inputText', () => {
  const response = codexDynamicToolResponse({
    format: 'grigdesk-work-content-v1',
    content: [{
      type: 'image',
      mimeType: 'image/jpeg',
      data: 'AQ=='
    }],
  });

  assert.deepEqual(response, {
    contentItems: [{ type: 'inputImage', imageUrl: 'data:image/jpeg;base64,AQ==' }], success: true,
  });
  assert.equal(codexDynamicToolResponse({ ok: false }).success, false);
});
