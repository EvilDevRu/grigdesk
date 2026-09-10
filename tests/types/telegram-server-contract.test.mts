import { parseTelegramLinks, telegramMessageLink } from '../../server/src/lib/telegram/links.ts';
import { normalizeUpdate } from '../../server/src/lib/telegram/updates.ts';
import { matchRule, normalizeRules } from '../../server/src/lib/telegram/rulesStore.ts';
import { checkScope } from '../../server/src/lib/telegram/linkScope.ts';
import { telegramActivationEpochFor } from '../../server/src/lib/telegram/activation.ts';
import { parseCallback } from '../../server/src/lib/telegram/pult/format.ts';
import type { TelegramMessage } from '../../server/src/lib/telegram/updates.ts';
import type { TelegramRule } from '../../server/src/lib/telegram/rulesStore.ts';
import type { TelegramModuleOptions } from '../../server/src/modules/telegram/index.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type MessageIsChecked = Checked<IsUnchecked<TelegramMessage>>;
export type RuleIsChecked = Checked<IsUnchecked<TelegramRule>>;
export type UpdateIsChecked = Checked<IsUnchecked<ReturnType<typeof normalizeUpdate>>>;
export type ConnectionIsChecked = Checked<IsUnchecked<TelegramModuleOptions['connection']>>;

/**
 * Границу канала держат три вещи: разбор апдейта, allowlist «чат → проект» и
 * граница приёма. Ни одна не должна принимать чужую форму от соседнего
 * JavaScript — иначе чужой чат развернётся в задаче, а история попадёт в очередь
 * как свежее обращение.
 */
function checkTelegramContracts(input: unknown): void {
  // @ts-expect-error Разбор апдейта может не найти ни сообщения, ни реакции.
  normalizeUpdate(input).msg.text.trim();
  // @ts-expect-error Ссылки могло не быть ни одной.
  parseTelegramLinks(input)[0].messageId;
  // @ts-expect-error Личка и старая группа канонической ссылки не имеют.
  telegramMessageLink({ chatId: -1001, messageId: 42 }).length.toFixed();
  // @ts-expect-error Правило может не найтись — чат не привязан ни к чему.
  matchRule(input, { chatId: 42 }).project.trim();
  // @ts-expect-error Строка архива без Inbox sequence остаётся историей.
  telegramActivationEpochFor(input, []).toFixed();
  // @ts-expect-error Нераспознанная кнопка не превращается в действие.
  parseCallback(input).kind.toUpperCase();

  const [rule] = normalizeRules(input);
  const verdict = checkScope(input, { chatId: 42 });

  // @ts-expect-error Правил может не оказаться вовсе.
  rule.b24.priority.toFixed();
  // @ts-expect-error У разрешённого адреса причины отказа нет.
  verdict.reason.trim();
}

void checkTelegramContracts;
