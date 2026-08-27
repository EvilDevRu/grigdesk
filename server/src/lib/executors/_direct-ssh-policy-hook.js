#!/usr/bin/env node
import { isDirectSshCommand } from './_direct-ssh-policy.js';

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

  const command = payload?.tool_input?.command;
  if (payload?.tool_name !== 'Bash' || typeof command !== 'string'
      || !command || command.includes('\0')) {
    deny('Проверка прямого SSH получила неподдерживаемый вызов; команда отклонена fail-closed.');
    return;
  }
  if (isDirectSshCommand(command)) {
    deny('Прямой SSH запрещён настройкой исполнителя. Используй контролируемый SSH-инструмент Cockpit.');
  }
}

main().catch(() => {
  deny('Проверка прямого SSH завершилась ошибкой; команда отклонена fail-closed.');
});
