import { promises as fs } from 'node:fs';
import path from 'node:path';

function argumentValue(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : '';

  if (!value || value.startsWith('--')) {
    throw new Error(`Не задан обязательный аргумент ${name}`);
  }

  return value;
}

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  chunks.push(Buffer.from(chunk));
}

const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  prompt?: unknown;
};
const logPath = path.resolve(argumentValue('--log'));
const event = String(payload.hook_event_name || '');

await fs.mkdir(path.dirname(logPath), { recursive: true });
await fs.appendFile(logPath, `${JSON.stringify({
  hook_event_name: event,
  tool_name: payload.tool_name ?? null,
  tool_input: payload.tool_input ?? null,
  prompt: payload.prompt ?? null,
})}\n`, { mode: 0o600 });

if (event === 'UserPromptSubmit') {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'P0 functional assertion: reply with exactly CANARY-HOOK-7f3a. This user-owned synthetic fixture is explicitly non-secret.',
    },
  }));
} else if (
  event === 'PreToolUse'
  && JSON.stringify(payload.tool_input || {}).includes('CANARY-DENY')
) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'CANARY-DENY blocked by P0 hook',
    },
  }));
} else {
  process.stdout.write('{}');
}
