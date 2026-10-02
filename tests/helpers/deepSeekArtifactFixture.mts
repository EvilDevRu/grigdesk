import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Малое поколение проверяет настоящий формат manifest и identity без SDK или prompt.
 * Для transport/model evidence используется отдельный действительно собранный candidate.
 */
export async function writeDeepSeekArtifactFixture(root: string, marker: string) {
  const contract = {
    format: 1,
    hostContract: 1,
    journalFormat: 1,
    source: {
      repository: 'https://github.com/deepseek-ai/deepseek-harness',
      commit: 'c291e7961a515f6d7af9304e7fd1d257929aef26',
      version: '0.1.5-rc.2',
    },
    nodeCompatibility: '^22.19.0 || >=24.0.0',
    entry: 'entry.mjs',
    capabilities: {
      web: true,
      acp: true,
      settingsWeb: true,
      settingsAcp: true,
    },
  };
  const entry = 'if (process.argv[2] !== "-V") throw new Error("Fixture запрещает prompt");\n'
    + 'console.log("0.1.5-rc.2");\n';
  const payload: Record<string, string> = {};

  await fs.mkdir(root, { recursive: true });

  for (const [name, content] of Object.entries({ 'entry.mjs': entry, 'dependency.js': marker })) {
    await fs.writeFile(path.join(root, name), content, { mode: 0o644 });
    payload[name] = createHash('sha256')
      .update(`420:${Buffer.from(content).toString('base64')}`).digest('hex');
  }

  const inputIdentity = {
    contract,
    platform: process.platform,
    arch: process.arch,
    nativeAbi: process.versions.modules,
    composition: marker,
  };
  const buildId = createHash('sha256').update(JSON.stringify({ inputIdentity, payload })).digest('hex');
  const metadata = {
    ...contract,
    buildId,
    runtimeVersion: `${contract.source.version}.cockpit.b${buildId.slice(0, 16)}`,
    inputIdentity,
    payload,
  };

  await fs.writeFile(path.join(root, 'runtime.json'), JSON.stringify(metadata));

  return metadata;
}
