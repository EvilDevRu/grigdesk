// MCP server requests Codex не являются обычными permissions: форма обязана сохранить
// машинные ключи и типы, URL — пройти allowlist, а любой неявный исход — стать cancel.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codexElicitationPresentation,
  codexElicitationResponse,
} from '../../server/src/lib/executors/_codexElicitation.ts';

function formParams(overrides = {}) {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    serverName: 'figma',
    mode: 'form',
    message: 'Параметры макета',
    requestedSchema: {
      type: 'object',
      required: ['count', 'approved', 'mode'],
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 12 },
        approved: { type: 'boolean', default: false },
        mode: {
          type: 'string',
          enum: ['safe_mode'],
          enumNames: ['Безопасный'],
        },
      },
    },
    ...overrides,
  };
}

test('standard form сохраняет primitive-типы и машинные enum values', () => {
  const presentation = codexElicitationPresentation(formParams());

  assert.equal(presentation.source, 'MCP · figma');
  assert.deepEqual(presentation.actions, ['accept', 'decline', 'cancel']);
  assert.deepEqual(
    presentation.questions.map(({ key, inputType, required, options, default: value }) => ({
      key, inputType, required, options, defaultValue: value,
    })),
    [
      {
        key: 'count', inputType: 'integer', required: true,
        options: undefined, defaultValue: undefined,
      },
      {
        key: 'approved', inputType: 'boolean', required: true,
        options: undefined, defaultValue: false,
      },
      {
        key: 'mode', inputType: 'choice', required: true,
        options: [{ value: 'safe_mode', label: 'Безопасный' }], defaultValue: undefined,
      },
    ],
  );

  assert.deepEqual(codexElicitationResponse(presentation, {
    action: 'accept',
    answers: [
      { key: 'count', value: 4 },
      { key: 'approved', value: false },
      { key: 'mode', value: 'safe_mode' },
    ],
  }), {
    action: 'accept',
    content: { count: 4, approved: false, mode: 'safe_mode' },
    _meta: null,
  });
  assert.deepEqual(codexElicitationResponse(presentation, {
    action: 'accept', answers: [{ key: 'count', value: '4' }],
  }), { action: 'cancel', content: null, _meta: null });
  assert.deepEqual(codexElicitationResponse(presentation, { action: 'decline' }), {
    action: 'decline', content: null, _meta: null,
  });
});

test('required означает наличие свойства, а не непустое значение JSON Schema', () => {
  const presentation = codexElicitationPresentation(formParams({
    requestedSchema: {
      type: 'object',
      required: ['label', 'layers'],
      properties: {
        label: { type: 'string', maxLength: 0 },
        layers: {
          type: 'array',
          minItems: 0,
          items: { type: 'string', enum: ['visible'] },
        },
      },
    },
  }));

  assert.deepEqual(codexElicitationResponse(presentation, {
    action: 'accept',
    answers: [{ key: 'label', value: '' }, { key: 'layers', value: [] }],
  }), {
    action: 'accept', content: { label: '', layers: [] }, _meta: null,
  });
});

test('URL elicitation принимает HTTPS и loopback HTTP, опасные схемы отклоняет', () => {
  const https = codexElicitationPresentation({
    ...formParams(),
    mode: 'url',
    message: 'Подключи Figma',
    url: 'https://www.figma.com/oauth?state=opaque',
    elicitationId: 'figma-oauth',
  });
  assert.equal(https.input.url, 'https://www.figma.com/oauth?state=opaque');
  assert.equal(https.canRemember, false);
  assert.deepEqual(codexElicitationResponse(https, { allow: true }), {
    action: 'accept', content: null, _meta: null,
  });
  assert.deepEqual(codexElicitationResponse(https, { allow: false }), {
    action: 'decline', content: null, _meta: null,
  });

  assert.ok(codexElicitationPresentation({
    ...formParams(), mode: 'url', url: 'http://127.0.0.1:34115/callback',
  }));
  for (const url of [
    'http://figma.example/connect',
    'https://user:secret@figma.example/connect',
    'javascript:alert(1)',
    'file:///tmp/token',
  ]) {
    assert.equal(codexElicitationPresentation({ ...formParams(), mode: 'url', url }), null);
  }
});

test('openai/form approval требует явного action и ограничивает persist capability', () => {
  const presentation = codexElicitationPresentation({
    ...formParams(),
    mode: 'openai/form',
    requestedSchema: { type: 'object', properties: {} },
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      persist: ['session', 'always'],
    },
  });

  assert.deepEqual(presentation.actions, ['accept', 'accept_session', 'accept_always', 'cancel']);
  assert.deepEqual(codexElicitationResponse(presentation, {}), {
    action: 'cancel', content: null, _meta: null,
  });
  assert.deepEqual(codexElicitationResponse(presentation, { action: 'accept_session' }), {
    action: 'accept', content: null, _meta: { persist: 'session' },
  });
  assert.deepEqual(codexElicitationResponse(presentation, { action: 'accept_always' }), {
    action: 'accept', content: null, _meta: { persist: 'always' },
  });
});
