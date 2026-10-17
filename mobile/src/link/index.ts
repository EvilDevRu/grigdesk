import { Capacitor } from '@capacitor/core';

import { nativeLink } from './nativeLink.ts';
import type { CockpitLink } from './types.ts';

let selected: Promise<CockpitLink> | null = null;

/**
 * Android использует исключительно native; разработка включается явным build flag.
 * Обычная release-страница в браузере не подменяет сеть синтетическими ответами.
 * Компьютер использует общую сборку с VITE_LINK=desktop и закрытым preload-мостом.
 */
export function getLink(): Promise<CockpitLink> {
  if (selected) {
    return selected;
  }
  if (Capacitor.getPlatform() === 'android') {
    selected = Promise.resolve(nativeLink);
  } else if (import.meta.env.VITE_LINK === 'mock') {
    selected = import('./mockLink.ts').then(
      ({ MockLink }) =>
        new MockLink(
          (globalThis as any).__COCKPIT_MOBILE_MOCK__ || {
            state: {
              paired: false,
              unlocked: false,
            },
          },
        ),
    );
  } else if (import.meta.env.VITE_LINK === 'dev') {
    selected = import('./devLink.ts').then(({ devLink }) => devLink);
  } else if (import.meta.env.VITE_LINK === 'desktop') {
    selected = import('./desktopLink.ts').then(({ desktopLink }) => desktopLink);
  } else {
    selected = Promise.reject(new Error('Открой приложение на телефоне.'));
  }

  return selected;
}
