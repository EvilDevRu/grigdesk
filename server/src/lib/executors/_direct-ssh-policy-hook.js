#!/usr/bin/env node
import { evaluateDirectCommand } from './_directSshPolicy.ts';

function deny(reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })}\n`);
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    deny('Запрос проверки прямого SSH повреждён; команда отклонена fail-closed.');
    return;
  }

  const args = process.argv.slice(2);
  let toolName = 'Bash';
  let commandField = 'command';
  let blockDirectSsh = true;
  let blockDirectDb = false;
  let strictUnknownDbClient = false;
  let invalidArgs = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--tool-name' || argument === '--command-field') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        invalidArgs = true;
        break;
      }
      if (argument === '--tool-name') toolName = value;
      else commandField = value;
      index += 1;
    } else if (argument === '--ssh') blockDirectSsh = true;
    else if (argument === '--no-ssh') blockDirectSsh = false;
    else if (argument === '--db') blockDirectDb = true;
    else if (argument === '--strict-db') strictUnknownDbClient = true;
    else invalidArgs = true;
  }
  if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/u.test(toolName)
      || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(commandField)) {
    invalidArgs = true;
  }

  const input = payload?.tool_input;
  const command = input && typeof input === 'object'
    && Object.prototype.hasOwnProperty.call(input, commandField)
    ? input[commandField]
    : undefined;
  if (invalidArgs || payload?.tool_name !== toolName || typeof command !== 'string'
      || !command || command.includes('\0')) {
    deny('Проверка прямого SSH получила неподдерживаемый вызов; команда отклонена fail-closed.');
    return;
  }
  const verdict = evaluateDirectCommand(command, {
    blockDirectSsh,
    blockDirectDb,
    strictUnknownDbClient,
  });
  if (verdict.verdict === 'deny') {
    deny(verdict.kind === 'db'
      ? 'Прямое подключение к внешней БД запрещено. Используй надзорный инструмент Cockpit.'
      : 'Прямой SSH запрещён настройкой исполнителя. Используй контролируемый SSH-инструмент Cockpit.');
  }
}

main().catch(() => {
  deny('Проверка прямого SSH завершилась ошибкой; команда отклонена fail-closed.');
});
