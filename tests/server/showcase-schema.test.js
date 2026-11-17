// Текущая схема ролика: nullable-стенд и отказ несовместимой версии.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createShowcaseStore } from '../../server/src/lib/showcase/store.ts';
import {
  parseShowcaseProject,
} from '../../shared/plugins/showcase/showcaseContracts.ts';

const READY_TARGET = {
  status: 'ready',
  ref: { kind: 'sandbox', id: '4920' },
  scope: {
    targetKind: 'sandbox',
    targetLabel: 'стенд 4920',
    profile: 'demo-profile',
    viewUrl: null,
    environment: 'read-only',
    capabilities: ['record'],
    screens: [{
      id: 'root',
      title: 'Главная',
      path: '/',
    }],
    targetFingerprint: 'f'.repeat(32),
    policyRevision: 'p'.repeat(32),
    dataRevision: 'начальные',
    buildRevision: null,
  },
};

function projectOf(overrides = {}) {
  return {
    schemaVersion: 2,
    id: 'abcdef1234',
    title: 'Задача 4920',
    revision: 1,
    ref: { kind: 'sandbox', id: '4920' },
    target: READY_TARGET,
    brief: [],
    scenes: [],
    decisions: [],
    latestFinal: null,
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
    ...overrides,
  };
}

test('ролик без стенда проходит контракт и не считается заблокированным', () => {
  const parsed = parseShowcaseProject(projectOf({
    schemaVersion: 2,
    ref: null,
    target: null,
    title: 'Новый ролик',
  }));

  assert.equal(parsed.ref, null);
  assert.equal(parsed.target, null);
});

test('несовместимая версия отказывает схемой', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-schema-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const store = createShowcaseStore({ showcaseDir: root });

  await store.ensureDirs();

  const names = store.namesOf('abcdef1234');

  await mkdir(path.dirname(names.file), { recursive: true });
  await writeFile(names.file, JSON.stringify(projectOf({ schemaVersion: 99 })), 'utf8');

  await assert.rejects(
    () => store.readProject('abcdef1234'),
    (error) => error.code === 'schema_mismatch',
  );
});
