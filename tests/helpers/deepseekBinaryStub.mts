import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

/**
 * Metadata stub не заменяет SEA/parity процесс и не зависит от PATH или внешнего dsh.
 * Собственный временный executable удаляется вместе с контекстом теста.
 */
export async function writeDeepSeekBinaryStub(
  t: TestContext,
  body: string,
  mode = 0o755,
): Promise<{ root: string; binary: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'binary-probe-'));
  const binary = path.join(root, 'executable');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(binary, `#!${process.execPath}\n${body}\n`, { mode });

  return { root, binary };
}

/**
 * Unit transport получает совместимый metadata double, сохраняя собственный spawn seam.
 * Этот helper не используется для настоящих SEA/native/parity сценариев.
 */
export async function writeDeepSeekMetadataStub(t: TestContext, toolPermissions = true) {
  const { runtimeInfoFixture } = await import('./deepseekMetadataFixture.mts');
  const metadata = JSON.stringify(JSON.stringify(runtimeInfoFixture({ toolPermissions })) + '\n');

  return writeDeepSeekBinaryStub(t, [
    'if (!process.argv.includes("--runtime-info")) throw new Error("Только metadata double");',
    `process.stdout.write(${metadata});`,
  ].join('\n'));
}
