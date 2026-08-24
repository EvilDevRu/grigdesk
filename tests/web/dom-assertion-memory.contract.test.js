import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parse } from '../../web/node_modules/acorn/dist/acorn.mjs';

const testsDir = path.dirname(new URL(import.meta.url).pathname);
const equalityAssertions = new Set([
  'equal', 'strictEqual', 'deepEqual', 'deepStrictEqual', 'notEqual', 'notStrictEqual',
]);
const domMemberNames = new Set([
  '$el', 'element', 'firstElementChild', 'lastElementChild', 'nextElementSibling',
  'parentElement', 'parentNode', 'previousElementSibling',
]);
const documentMemberNames = new Set(['activeElement', 'body', 'documentElement']);
const domQueryNames = new Set(['closest', 'querySelector', 'querySelectorAll']);

function memberName(node) {
  if (!node?.computed && node?.property?.type === 'Identifier') return node.property.name;
  if (node?.computed && node?.property?.type === 'Literal') return node.property.value;
  return null;
}

function directDomValue(node) {
  if (node?.type === 'ChainExpression') return directDomValue(node.expression);
  if (node?.type === 'MemberExpression') {
    const name = memberName(node);
    const owner = node.object?.type === 'Identifier' ? node.object.name : memberName(node.object);
    return domMemberNames.has(name) || (documentMemberNames.has(name) && owner === 'document');
  }
  return node?.type === 'CallExpression'
    && node.callee?.type === 'MemberExpression'
    && domQueryNames.has(memberName(node.callee));
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
    else walk(value, visit);
  }
}

test('DOM-узлы не передаются напрямую в equality-assert', async () => {
  const files = (await readdir(testsDir)).filter((file) => file.endsWith('.test.js')).sort();
  const findings = [];

  for (const file of files) {
    const source = await readFile(path.join(testsDir, file), 'utf8');
    const tree = parse(source, { ecmaVersion: 'latest', locations: true, sourceType: 'module' });
    walk(tree, (node) => {
      if (node.type !== 'CallExpression' || node.callee?.type !== 'MemberExpression') return;
      if (node.callee.object?.type !== 'Identifier' || node.callee.object.name !== 'assert') return;
      if (!equalityAssertions.has(memberName(node.callee))) return;
      if (!directDomValue(node.arguments[0]) && !directDomValue(node.arguments[1])) return;
      findings.push(`${file}:${node.loc.start.line}`);
    });
  }

  assert.deepEqual(findings, [], 'сравнивай Boolean/===, атрибут, текст или другое скалярное значение');
});
