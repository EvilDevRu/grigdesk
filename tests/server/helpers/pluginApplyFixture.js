import { execFileSync } from 'node:child_process';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import os from 'node:os';

import path from 'node:path';

import { createApplyFs } from '../../../server/src/lib/packageInstall/applyPackage.ts';

import { computePayloadDigest } from '../../../server/src/lib/packageInstall/payloadDigest.ts';

import { safeGitConfigDigest } from '../../../server/src/lib/packageInstall/gitMetadata.ts';

import { PluginInstallStateStore } from '../../../server/src/lib/packageInstall/stateStore.ts';

import { applyingState, installedRecord } from './pluginInstallState.js';

import { adapterSource } from './dbEngineFixture.js';

/**
 * Каждый участник имеет узнаваемые bytes, собственный inode и полный digest.
 * Fixture использует настоящие каталоги и только свой Git init без host config.
 */
export async function createApplyFixture(
  t,
  {
    kind = 'install',
    packageKind = 'plugin',
    withPrevious = false,
    unmanaged = false,
    importMarker = false,
    workInside = false,
    root: fixtureRoot,
  } = {},
) {
  const root = fixtureRoot ?? await mkdtemp(path.join(os.tmpdir(), 'grigdesk-apply-'));

  const roots = {
    pluginsDir: path.join(root, packageKind === 'db-engine' ? 'db-engines' : 'plugins'),
    workDir: path.join(root, 'work'),
  };

  if (workInside) {
    roots.workDir = path.join(roots.pluginsDir, '.grigdesk-install');
  }

  const state = applyingState(kind, unmanaged ? 'replaced' : kind === 'install' ? 'none' : 'previous');

  const intent = state.apply;

  const fs = createApplyFs(roots);

  const current = path.join(roots.pluginsDir, 'demo');

  const previous = path.join(roots.workDir, 'previous/demo');

  const jobDir = path.join(roots.workDir, 'jobs', intent.jobId);

  const candidate = kind === 'rollback' ? previous : path.join(jobDir, 'package');

  const transaction = path.join(roots.workDir, 'transactions', intent.transactionId);

  const statePath = path.join(root, 'state/install.json');

  const store = new PluginInstallStateStore({ statePath, hasWorkEvidence: async () => true });

  if (!fixtureRoot) {
    t.after(() => rm(root, { recursive: true, force: true }));
  }

  for (const directory of [roots.pluginsDir, jobDir, path.join(roots.workDir, 'transactions'),
  path.dirname(previous), path.join(roots.workDir, 'replaced'), path.dirname(statePath)]) {
    await mkdir(directory, { recursive: true });
  }

  const markerPath = importMarker ? path.join(root, 'import-marker') : null;

  const target = await createCopy(
    candidate, kind === 'rollback' ? '0.9.0' : '1.1.0', 'new', 2, markerPath, packageKind,
  );

  intent.targetRecord = target;

  intent.candidate = await fs.lstatIdentity(candidate, []);

  state.job.source = target.source;

  state.job.target = {
    version: target.version,
    tag: target.tag,
    sha: target.sha,
  };

  state.job.preview.source = state.job.source;

  state.job.preview.target = state.job.target;

  state.job.preview.version = target.version;

  if (kind === 'install' && !unmanaged) {
    state.plugins = {};

    intent.baseRecord = null;

    intent.current = null;

    intent.previous = null;
  } else {
    const base = await createCopy(current, '1.0.0', 'old', 1, markerPath, packageKind);

    state.plugins.demo = base;

    intent.baseRecord = base;

    intent.current = await fs.lstatIdentity(current, []);

    if (kind === 'rollback') {
      base.previous = versionSnapshot(target);

      intent.previous = intent.candidate;
    } else if (withPrevious) {
      const older = await createCopy(previous, '0.9.0', 'older', 1, null, packageKind);

      base.previous = versionSnapshot(older);

      intent.previous = await fs.lstatIdentity(previous, []);
    }

    if (unmanaged) {
      state.plugins = {};

      intent.baseRecord = null;

      delete intent.current.payloadDigest;

      intent.archiveKey = `demo-20260101T000000000Z-${intent.transactionId}`;
    } else if (intent.destination === 'previous') {
      target.previous = versionSnapshot(base);
    }
  }

  state.apply = null;

  state.job.status = 'ready';

  await writeFile(statePath, JSON.stringify(state));

  return {
    root,
    roots,
    fs,
    store,
    state,
    intent,
    current,
    previous,
    candidate,
    jobDir,
    transaction,
    statePath,
  };
}

/**
 * Payload остаётся обычным package; server.js исполняет лишь явный positive control fixture.
 * Clone config digest берётся из настоящей проверенной Git metadata.
 */
async function createCopy(directory, version, marker, revision, importMarker = null, packageKind = 'plugin') {
  await mkdir(directory, { recursive: true });

  const manifest = packageKind === 'db-engine' ? {
    id: 'demo',
    label: 'Драйвер',
    kind: 'db-engine',
    api: 1,
    minimum: '0.0.0',
    entry: 'entry.mjs',
  } : { id: 'demo', version };

  await writeFile(path.join(directory, packageKind === 'db-engine' ? 'engine.json' : 'plugin.json'),
    JSON.stringify(manifest));

  await writeFile(path.join(directory, 'marker.txt'), marker);

  const server = importMarker ? `import fs from 'node:fs';\n`
    + `fs.writeFileSync(${JSON.stringify(importMarker)}, 'loaded');\nexport default async () => {};\n`
    : 'export default async () => {};\n';

  if (packageKind === 'db-engine') {
    const prefix = importMarker ? `import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(importMarker)}, ${JSON.stringify(version)});` : '';

    await writeFile(path.join(directory, 'entry.mjs'), adapterSource('demo', prefix));
  } else {
    await writeFile(path.join(directory, 'server.js'), server);
  }

  execFileSync('/usr/bin/git', ['init', '--template=', directory], {
    env: {
      PATH: '/usr/bin:/bin',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    stdio: 'ignore',
  });

  return {
    ...installedRecord(version, revision),
    payloadDigest: await computePayloadDigest(directory),
    gitConfigDigest: await safeGitConfigDigest(directory),
  };
}

/**
 * Previous snapshot исключает live bookkeeping поля установленного record.
 * При rollback этот полный снимок возвращает прежний source и npmDirs.
 */
export function versionSnapshot(record) {
  const { revision: _revision, previous: _previous, latest: _latest, checkedAt: _checkedAt,
    checkError: _checkError, ...version } = record;

  return version;
}
