import type { TelegramBot, TelegramRule, TelegramStatus } from '../../shared/telegram/telegramContracts.ts';
import { parseTelegramRules, parseTelegramStatus } from '../../shared/telegram/telegramContracts.ts';
import { telegramApi } from '../../web/src/shared/telegramApi.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type BotIsChecked = Checked<IsUnchecked<TelegramBot>>;
export type StatusIsChecked = Checked<IsUnchecked<TelegramStatus>>;
export type ApiRulesIsChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof telegramApi.rules>>>>;

/**
 * Примеры запускает только компилятор. Вид правила и состояние подключения —
 * рубежи решений: по первому собирается задача в Битрикс24, по второму человек
 * понимает, чинить ли токен. Непроверенный JSON не имеет права стать ни тем, ни другим.
 */
function checkContracts(input: unknown): void {
  // @ts-expect-error Непроверенный JSON не является состоянием раздела.
  const unchecked: TelegramStatus = input;
  // @ts-expect-error Вид правила закрыт перечислением.
  const kind: TelegramRule['kind'] = 'вопрос';
  // @ts-expect-error Ступень приоритета портала — закрытый набор 0|1|2.
  const priority: TelegramRule['b24']['priority'] = 7;
  // @ts-expect-error Сохранение правил идёт под отпечатком, а не вслепую.
  telegramApi.saveRules([]);
  // @ts-expect-error Подтверждение пульта называет и бота, и код из лички.
  telegramApi.confirmPult('8123456789');

  const status = parseTelegramStatus(input);
  const rules = parseTelegramRules(input);

  // @ts-expect-error Пульта может не быть настроено вовсе.
  status.pult.chatTitle.trim();
  // @ts-expect-error Правил может не оказаться ни одного.
  rules.rules[0].project.trim();

  void [unchecked, kind, priority];
}

void checkContracts;
