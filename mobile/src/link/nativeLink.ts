import { registerPlugin } from '@capacitor/core';

import type { GrigDeskLink } from './types.ts';

const plugin = registerPlugin<GrigDeskLink>('GrigDeskLink');

/**
 * Прокси Capacitor отдаёт обёртку нативного метода на любое имя, в том числе `then`.
 * Отданный из Promise мост иначе принимался за thenable, и `await getLink()` висел вечно.
 */
export const nativeLink: GrigDeskLink = new Proxy(plugin, {
  get(target, property, receiver) {
    return property === 'then' ? undefined : Reflect.get(target, property, receiver);
  },
});
