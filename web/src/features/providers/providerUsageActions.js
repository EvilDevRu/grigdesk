import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { translate as t } from '../../../../shared/i18n/catalogs.ts';
// Provider adapter описывает разрешённые действия декларативно. Клиент только
// проверяет пользовательский ввод и отправляет opaque action id обратно store.

function numberOf(value) {
  if (typeof value === 'number') {
    return value;
  }

  return Number(String(value ?? '').trim().replace(',', '.'));
}

/**
 * Проверка значения предшествует подтверждению и отправке действия провайдеру.
 * Локализованная ошибка не меняет payload и не преобразует неизвестный ответ сервера.
 */
export function prepareUsageControl(control, input,
  locale = 'ru',
) {
  const t = localeTranslator(locale);

  if (!control || !control.action) {
    return {
      ok: false,
      error: t("core.actionUnsupported"),
    };
  }

  const payload = {
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
        && value <= control.minExclusive
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

function confirmationOf(control, value) {
  if (control?.kind === 'toggle') {
    return value
      ? control.confirm?.on
      : control.confirm?.off;
  }

  return control?.confirm;
}

/**
 * Вопрос и кнопки строятся из публичного контракта действия при показе.
 * Подстановка значения не меняет само значение, отправляемое провайдеру.
 */
export function usageControlConfirmation(control, value,
  locale = 'ru',
) {
  const t = localeTranslator(locale);

  const confirmation = confirmationOf(control, value) || {};
  const replacements = {
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
