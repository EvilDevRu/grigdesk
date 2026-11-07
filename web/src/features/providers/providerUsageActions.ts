import { type LocaleSource, localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { translate as t } from '../../../../shared/i18n/catalogs.ts';

interface Confirmation {
  text?: string;
  label?: string;
  danger?: boolean;
}

interface ToggleConfirmation {
  on?: Confirmation;
  off?: Confirmation;
}

interface UsageControl {
  action?: string;
  payload?: Record<string, unknown>;
  kind?: string;
  field?: string;
  minExclusive?: number;
  label?: string;
  unit?: string;
  confirm?: Confirmation | ToggleConfirmation;
}

type PreparedControl = { ok: false; error: string } | {
  ok: true;
  actionId: string;
  payload: Record<string, unknown>;
  value: unknown;
};

// Provider adapter описывает разрешённые действия декларативно. Клиент только
// проверяет пользовательский ввод и отправляет opaque action id обратно store.

function numberOf(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }

  return Number(String(value ?? '').trim().replace(',', '.'));
}

/**
 * Проверка значения предшествует подтверждению и отправке действия провайдеру.
 * Локализованная ошибка не меняет payload и не преобразует неизвестный ответ сервера.
 */
export function prepareUsageControl(control: UsageControl | null | undefined, input: unknown,
  locale: LocaleSource = 'ru',
): PreparedControl {
  const t = localeTranslator(locale);

  if (!control || !control.action) {
    return {
      ok: false,
      error: t("core.actionUnsupported"),
    };
  }

  const payload: Record<string, unknown> = {
    ...(control.payload && typeof control.payload === 'object'
      ? control.payload
      : {}),
  };
  let value = input;

  if (control.kind === 'toggle') {
    value = Boolean(input);

    if (!control.field) {
      return {
        ok: false,
        error: t("core.invalidToggle"),
      };
    }

    payload[control.field] = value;
  } else if (control.kind === 'number') {
    value = numberOf(input);

    if (
      !Number.isFinite(value)
      || !control.field
      || (
        Number.isFinite(control.minExclusive)
        && (value as number) <= control.minExclusive!
      )
    ) {
      return {
        ok: false,
        error: t("core.aPositiveNumber", { value1: control.label || t("core.value") }),
      };
    }

    payload[control.field] = value;
  } else if (control.kind !== 'button') {
    return {
      ok: false,
      error: t("core.unknownActionType"),
    };
  }

  return {
    ok: true,
    actionId: control.action,
    payload,
    value,
  };
}

/**
 * У тумблера выбирает подтверждение именно будущего состояния.
 * Обычная кнопка использует единый текст, объявленный адаптером.
 */
function confirmationOf(control: UsageControl | null | undefined, value: unknown): Confirmation | undefined {
  if (control?.kind === 'toggle') {
    return value
      ? (control.confirm as ToggleConfirmation | undefined)?.on
      : (control.confirm as ToggleConfirmation | undefined)?.off;
  }

  return control?.confirm as Confirmation | undefined;
}

/**
 * Вопрос и кнопки строятся из публичного контракта действия при показе.
 * Подстановка значения не меняет само значение, отправляемое провайдеру.
 */
export function usageControlConfirmation(control: UsageControl | null | undefined, value: unknown,
  locale: LocaleSource = 'ru',
) {
  const t = localeTranslator(locale);

  const confirmation = confirmationOf(control, value) || {};
  const replacements: Record<string, unknown> = {
    value: value ?? '',
    unit: control?.unit || '',
  };
  const text = String(
    confirmation.text || t("core.performAction", { value1: control?.label || '' }),
  )
    .replace(
      /\{(value|unit)\}/g,
      (_, key) => String(replacements[key]),
    )
    .replace(/ +([?.!,])/g, '$1');

  return {
    text,
    label: String(confirmation.label || control?.label || t("settings.apply")),
    danger: confirmation.danger === true,
  };
}
