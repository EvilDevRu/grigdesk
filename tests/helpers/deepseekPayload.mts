import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type test from 'node:test';

import { sha256 } from '../../shared/node/hash.ts';
import { makeReadOnlyTree } from '../../shared/node/files.ts';
import { hashRuntimePayload } from '../../deepseek/scripts/buildRuntime.mts';
import { writeDeepSeekArtifactFixture } from './deepSeekArtifactFixture.mts';

/**
 * Миниатюрный payload содержит настоящий manifest generation и inventory лицензий.
 * Проверяется упаковка байтов; настоящий worker ELF проверяет отдельный SEA-набор.
 */
export async function deepSeekPayloadFixture(t: test.TestContext, reverse = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'payload source '));
  const generationDirectory = path.join(root, 'generation');
  const metadata = await writeDeepSeekArtifactFixture(generationDirectory, 'payload-bytes');
  const notice = 'Полный синтетический notice\n';
  const licenses = {
    format: 1,
    packages: [{
      name: 'fixture',
      files: [{ copy: 'fixture.txt', sha256: sha256(notice) }],
    }],
  };
  const files = {
    LICENSE: notice,
    'THIRD_PARTY_NOTICES.md': notice,
    'licenses/UPSTREAM_NOTICES.md': notice,
    'licenses/fixture.txt': notice,
    'licenses/index.json': JSON.stringify(licenses),
  };

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(generationDirectory, 'licenses'));

  const entries = Object.entries(files);

  for (const [name, content] of reverse ? entries.reverse() : entries) {
    await fs.writeFile(path.join(generationDirectory, name), content, { mode: 0o644 });
    metadata.payload[name] = sha256(`420:${Buffer.from(content).toString('base64')}`);
  }

  await fs.chmod(path.join(generationDirectory, 'dependency.js'), 0o755);
  metadata.payload['dependency.js'] = sha256(`493:${Buffer.from('payload-bytes').toString('base64')}`);
  await fs.symlink('dependency.js', path.join(generationDirectory, 'relative-link'));
  metadata.payload['relative-link'] = sha256('link:dependency.js');
  await fs.unlink(path.join(generationDirectory, 'runtime.json'));
  await makeReadOnlyTree(generationDirectory);
  metadata.payload = await hashRuntimePayload(generationDirectory);
  metadata.buildId = createHash('sha256').update(JSON.stringify({
    inputIdentity: metadata.inputIdentity,
    payload: metadata.payload,
  })).digest('hex');
  metadata.runtimeVersion = `${metadata.source.version}.grigdesk.b${metadata.buildId.slice(0, 16)}`;

  await fs.writeFile(path.join(generationDirectory, 'runtime.json'), JSON.stringify(metadata), {
    mode: 0o444,
  });
  await fs.writeFile(path.join(root, 'node'), 'ordinary-node-bytes', { mode: 0o755 });
  await fs.writeFile(path.join(root, 'NODE-LICENSE'), 'node-license-bytes');
  await fs.writeFile(path.join(root, 'bootstrap.mjs'), '// worker bootstrap\n');
  await fs.writeFile(path.join(root, 'verify.mjs'), '// worker verification\n');
  await fs.writeFile(path.join(root, '.env'), 'SYNTHETIC_SECRET_MUST_STAY_OUTSIDE');

  return {
    root,
    options: {
      generationDirectory,
      workerNode: path.join(root, 'node'),
      nodeLicense: path.join(root, 'NODE-LICENSE'),
      workerBootstrap: path.join(root, 'bootstrap.mjs'),
      workerVerify: path.join(root, 'verify.mjs'),
      worker: {
        nodeVersion: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        nativeAbi: process.versions.modules,
      },
      outputFile: path.join(root, 'payload.zip'),
    },
  };
}

