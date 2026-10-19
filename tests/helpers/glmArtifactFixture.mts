import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { decodeDeepSeekRuntimeInfo } from '../../shared/chat/deepSeekBinary.ts';
import { runtimeInfoFixture } from './deepseekMetadataFixture.mts';

export const GLM_FIXTURE_PLUGIN = Object.freeze({
  piAi: {
    version: '0.85.1',
    integrity: 'sha512-synthetic',
  },
  sourceHash: 'a'.repeat(64),
  patches: [{ path: 'synthetic.patch', sha256: 'b'.repeat(64) }],
});

/**
 * Малое поколение в формате настоящего runtime.json: контракт, identity и payload.
 * Поле llmPiAi входит в контракт, как у сборщика; без него поколение «без плагина».
 */
export async function writeGlmArtifactFixture(root: string, options: {
  llmPiAi?: unknown;
  entry?: string;
  dependencyLock?: string;
} = {}) {
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
    ...(options.llmPiAi === undefined ? {} : { llmPiAi: options.llmPiAi }),
  };
  const fallback = 'if (process.argv[2] !== "-V") throw new Error("Fixture запрещает prompt");\n'
    + 'console.log("0.1.5-rc.2");\n';
  const entry = options.entry ?? fallback;
  const payload: Record<string, string> = {};

  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'entry.mjs'), entry, { mode: 0o644 });
  payload['entry.mjs'] = createHash('sha256').update(`420:${Buffer.from(entry).toString('base64')}`)
    .digest('hex');

  const inputIdentity = {
    contract,
    composition: 'grigdesk-host-web-acp-v3',
    dependencyLock: options.dependencyLock ?? 'c'.repeat(64),
    platform: process.platform,
    arch: process.arch,
    nativeAbi: process.versions.modules,
  };
  const buildId = createHash('sha256').update(JSON.stringify({ inputIdentity, payload })).digest('hex');
  const metadata = {
    ...contract,
    buildId,
    runtimeVersion: `${contract.source.version}.grigdesk.b${buildId.slice(0, 16)}`,
    inputIdentity,
    payload,
  };

  await fs.writeFile(path.join(root, 'runtime.json'), JSON.stringify(metadata));

  // Unit double содержит metadata в своих bytes и не выдаёт generation за готовый ELF.
  // Настоящие compiled/parity наборы используют исключительно ensureTestDeepSeekBinary.
  const original = runtimeInfoFixture();
  const info = decodeDeepSeekRuntimeInfo({
    ...original,
    buildId,
    upstreamVersion: contract.source.version,
    runtimeVersion: metadata.runtimeVersion,
    journal: { write: 3, read: [0, 1, 2, 3] },
    glm: {
      ...original.glm,
      inputs: {
        source: { commit: contract.source.commit },
        inputIdentity: {
          composition: inputIdentity.composition,
          dependencyLock: inputIdentity.dependencyLock,
        },
        llmPiAi: options.llmPiAi ?? null,
      },
      admission: [],
    },
  });

  info.packageId = createHash('sha256')
    .update(JSON.stringify({ ...info, packageId: undefined })).digest('hex');

  const body = [
    `#!${process.execPath}`,
    `const info = ${JSON.stringify(info)};`,
    'const args = process.argv.slice(2);',
    'if (args.includes("--runtime-info")) { console.log(JSON.stringify(info)); process.exit(0); }',
    'if (args.includes("-V") || args.includes("--version")) {',
    '  console.log(info.upstreamVersion); process.exit(0);',
    '}',
    'const stripped = [];',
    'for (let i = 0; i < args.length; i++) {',
    '  if (["--expect-package-id", "--cache-dir"].includes(args[i])) { i++; continue; }',
    '  stripped.push(args[i]);',
    '}',
    `process.argv = [process.execPath, ${JSON.stringify(path.join(root, 'entry.mjs'))}, ...stripped];`,
    `await import(${JSON.stringify(pathToFileURL(path.join(root, 'entry.mjs')).href)});`,
  ].join('\n');

  await fs.writeFile(path.join(root, 'deepseek'), body, { mode: 0o755 });


  return metadata;
}
