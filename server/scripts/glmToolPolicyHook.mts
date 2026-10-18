// Hook политики инструментов GLM. Канал hooks в DSH fail-open: блокирует только exit 2,
// поэтому любая ошибка, неразбираемый вход и неизвестное событие здесь тоже дают exit 2.
// Hook исполняется в песочнице процесса: наружу он сообщает только через stderr,
// который DSH публикует в событии hook/result. Аргументы вызова в stderr не попадают.
import { readFileSync } from 'node:fs';

import { decideGlmTool, glmArgumentsHash, parseGlmToolPolicy } from '../src/lib/glm/policy.ts';

/**
 * Отказ с причиной для модели. Exit 1 или сигнал DSH пропустил бы инструмент,
 * поэтому любой путь отказа завершается кодом 2.
 */
function deny(reason: string): never {
  process.stderr.write(`Инструмент запрещён политикой GrigDesk (GLM): ${reason}\n`);
  process.exit(2);
}

process.on('uncaughtException', () => deny('внутренняя ошибка hook'));
process.on('unhandledRejection', () => deny('внутренняя ошибка hook'));

function report(value: Record<string, unknown>): void {
  process.stderr.write(`GLM-POLICY ${JSON.stringify(value)}\n`);
}

/**
 * Вход hook ограничен по объёму: огромный stdin не должен держать ход.
 * Неразбираемый JSON — отказ, а не пропуск.
 */
async function stdin(): Promise<string> {
  let value = '';

  for await (const chunk of process.stdin) {
    value += String(chunk);

    if (Buffer.byteLength(value, 'utf8') > 4 * 1024 * 1024) {
      deny('вход hook слишком велик');
    }
  }

  return value;
}

const index = process.argv.indexOf('--policy');
const policyFile = index >= 0 ? process.argv[index + 1] : '';

if (!policyFile) {
  deny('не задана политика запуска');
}

const policy = parseGlmToolPolicy(JSON.parse(readFileSync(policyFile!, 'utf8')));
const payload = JSON.parse(await stdin()) as Record<string, unknown> | null;

if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
  deny('вход hook повреждён');
}

if (payload!.hook_event_name === 'UserPromptSubmit') {
  // Имена (не значения) окружения — наблюдаемое доказательство, что ключа маршрута здесь нет.
  report({
    event: 'UserPromptSubmit',
    marker: 'hooks-alive',
    envNames: Object.keys(process.env).sort(),
  });
  process.exit(0);
}

if (payload!.hook_event_name !== 'PreToolUse' || typeof payload!.tool_name !== 'string'
  || typeof payload!.tool_use_id !== 'string') {
  deny('неожиданное событие hook');
}

const name = String(payload!.tool_name);
const decision = decideGlmTool(name, payload!.tool_input, policy);

report({
  event: 'PreToolUse',
  tool_use_id: payload!.tool_use_id,
  name,
  sha256: glmArgumentsHash(payload!.tool_input ?? null),
  kind: decision.kind,
  decision: decision.allow ? 'allow' : 'deny',
});

if (!decision.allow) {
  deny(decision.reason);
}

process.exit(0);
