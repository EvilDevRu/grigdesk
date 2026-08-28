import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const FIELDS_PATH = new URL('../../web/src/styles/components/fields.css', import.meta.url);
const FLAT_RULE = new RegExp(
  String.raw`\.ui-select\[data-context='chat-session-toolbar'\],\s*`
    + String.raw`\.ui-select\[data-context='code-head-select'\]\s*\{([^}]*)\}`,
  'u',
);

test('селекты чата сохраняют прежний плоский skin', () => {
  const source = readFileSync(FIELDS_PATH, 'utf8');
  const flatRule = source.match(FLAT_RULE);

  assert.ok(flatRule, 'чат должен делить плоский skin только с селектами шапки кода');

  const declarations = flatRule[1];

  assert.match(declarations, /height:\s*28px/u);
  assert.match(declarations, /border:\s*0/u);
  assert.match(declarations, /border-bottom:\s*1px solid transparent/u);
  assert.match(declarations, /border-radius:\s*0/u);
  assert.match(declarations, /background-color:\s*transparent/u);
  assert.doesNotMatch(
    source,
    /\.ui-select\[data-context='pipeline-toolbar-select'\]\s*\{/u,
    'в панели конвейера больше нет проектного селекта с отдельным skin',
  );
});
