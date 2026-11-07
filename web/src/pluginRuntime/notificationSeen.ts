interface SeenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Повреждённый seen не превращается в отказ входа или потери результата.
 * Принимаются только bounded opaque ключи прежнего и общего формата.
 */
export function readNotificationSeen(storage: Pick<SeenStorage, 'getItem'>, key: string): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? '[]');

    return Array.isArray(value) ? value.filter((item): item is string =>
      typeof item === 'string' && item.length > 0 && item.length <= 512).slice(-500) : [];
  } catch {
    return [];
  }
}

/**
 * Прежние исходы Studio3D импортируются до первой live/snapshot доставки владельцу.
 * Target пишется перед marker, исходный ключ сохраняется для ручного отката ядра.
 */
export function importStudio3dSeen(clientScope: string, storage: SeenStorage): string[] {
  const source = `grigdesk-studio3d-seen:${clientScope}`;
  const target = `grigdesk-plugin-notifications-seen:${clientScope}:studio3d`;
  const marker = `grigdesk-plugin-notifications-seen-imported:${clientScope}:studio3d`;
  const current = readNotificationSeen(storage, target);

  try {
    if (storage.getItem(marker) === '1') {
      return current;
    }
  } catch {
    // Без доступного marker повторяется безопасный union, без чтения другого owner.
  }

  const merged = new Set<string>();

  for (const key of [...readNotificationSeen(storage, source), ...current]) {
    merged.delete(key);
    merged.add(key);
  }

  const retained = [...merged].slice(-500);

  try {
    storage.setItem(target, JSON.stringify(retained));
    storage.setItem(marker, '1');
  } catch {
    // При запрете записи тот же union остаётся в памяти bridge, marker не обещается.
  }

  return retained;
}
