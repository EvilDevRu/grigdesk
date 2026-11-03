import { browserUrl } from '../../../../shared/browser/browserContract.ts';
import type { BrowserPreferences } from '../../../../shared/browser/browserContract.ts';

/**
 * Все ссылки стендов используют одно предпочтение текущего desktop-клиента.
 * Fallback разрешён только без native capability, а не после неизвестного результата POST.
 */
export async function openStand(port: {
  available: boolean;
  preferences: Pick<BrowserPreferences, 'open'>;
  native(value: unknown): Promise<unknown>;
}, value: string, override?: 'internal' | 'external', deduplicate = true): Promise<boolean> {
  if (!port.available) {
    return false;
  }

  await port.native({
    operation: 'open',
    url: browserUrl(value),
    target: override ?? port.preferences.open,
    deduplicate,
  });

  return true;
}
