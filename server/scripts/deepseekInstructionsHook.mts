import { promises as fs } from 'node:fs';
import path from 'node:path';

import { expandInstructionImports } from '../src/lib/deepseek/instructions.ts';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : '';
  if (!value || value.startsWith('--')) throw new Error(`не задан ${name}`);
  return value;
}

async function stdin(): Promise<string> {
  let value = '';
  for await (const chunk of process.stdin) {
    value += String(chunk);
    if (Buffer.byteLength(value, 'utf8') > 1024 * 1024) throw new Error('stdin слишком велик');
  }
  return value;
}

async function main(): Promise<Record<string, unknown>> {
  const projectRoot = argument('--root');
  const cwd = argument('--cwd');
  if (!path.isAbsolute(projectRoot) || !path.isAbsolute(cwd)) {
    throw new Error('root и cwd должны быть абсолютными');
  }
  const payload = JSON.parse(await stdin()) as { hook_event_name?: unknown };
  if (payload?.hook_event_name !== 'UserPromptSubmit') {
    throw new Error('неожиданное событие hook');
  }
  await fs.access(path.join(projectRoot, '.git'));
  const result = await expandInstructionImports({ projectRoot, cwd });
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: result.context,
    },
  };
}

try {
  process.stdout.write(`${JSON.stringify(await main())}\n`);
} catch (error) {
  const message = String((error as Error)?.message || error);
  process.stderr.write(`DeepSeek instructions hook: корень/вход недоступен: ${message}\n`);
  process.stdout.write('{}\n');
}
