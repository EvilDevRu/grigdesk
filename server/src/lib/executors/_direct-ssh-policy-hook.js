#!/usr/bin/env node
import { isDirectRun } from '../helperEntry.ts';

function deny(reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })}\n`);
}

/**
 * Читает PreToolUse JSON, разбирает аргументы хука и отвечает deny при запрете.
 * Неподдерживаемый вызов тоже отклоняется fail-closed.
 */
async function run() {
  // Ошибка загрузки политики, включая каталог helper-ов, попадает в main/deny.
  // Статический импорт завершал хук до обработчика и открывал команду при сбое.
  const { evaluateDirectCommand } = await import('./_directSshPolicy.ts');

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
      ? 'Прямое подключение к внешней БД запрещено. Используй надзорный инструмент GrigDesk.'
      : 'Прямой SSH запрещён настройкой исполнителя. Используй контролируемый SSH-инструмент GrigDesk.');
  }
}

/**
 * Выполняет проверку и в любом отказе отвечает запретом fail-closed.
 * Экспорт нужен сгенерированному helper-entry; прямой запуск идёт через guard.
 */
export async function main() {
  try {
    await run();
  } catch {
    deny('Проверка прямого SSH завершилась ошибкой; команда отклонена fail-closed.');
  }
}

if (isDirectRun(import.meta.url)) {
  void main();
}
