import { registerPlugin } from '@capacitor/core';

import type { CockpitLink } from './types.ts';

const plugin = registerPlugin<CockpitLink>('CockpitLink');

/**
 * Прокси Capacitor отдаёт обёртку нативного метода на любое имя, в том числе `then`.
 * Отданный из Promise мост иначе принимался за thenable, и `await getLink()` висел вечно.
 */
export const nativeLink: CockpitLink = new Proxy(plugin, {
  get(target, property, receiver) {
    return property === 'then' ? undefined : Reflect.get(target, property, receiver);
  },
});
