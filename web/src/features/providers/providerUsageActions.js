// Provider adapter описывает разрешённые действия декларативно. Клиент только
// проверяет пользовательский ввод и отправляет opaque action id обратно store.

function numberOf(value) {
  if (typeof value === 'number') {
    return value;
  }

  return Number(String(value ?? '').trim().replace(',', '.'));
}

export function prepareUsageControl(control, input) {
  if (!control || !control.action) {
    return {
      ok: false,
      error: 'Действие не поддерживается',
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
        error: 'Некорректный тумблер',
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
        error: `${control.label || 'Значение'} — положительное число`,
      };
    }

    payload[control.field] = value;
  } else if (control.kind !== 'button') {
    return {
      ok: false,
      error: 'Неизвестный тип действия',
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

export function usageControlConfirmation(control, value) {
  const confirmation = confirmationOf(control, value) || {};
  const replacements = {
    value: value ?? '',
    unit: control?.unit || '',
  };
  const text = String(
    confirmation.text || `Выполнить действие «${control?.label || ''}»?`,
  )
    .replace(
      /\{(value|unit)\}/g,
      (_, key) => String(replacements[key]),
    )
    .replace(/ +([?.!,])/g, '$1');

  return {
    text,
    label: String(confirmation.label || control?.label || 'Применить'),
    danger: confirmation.danger === true,
  };
}
