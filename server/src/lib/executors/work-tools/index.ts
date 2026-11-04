import browser from './browser.ts';
import help from './help.ts';
import { browserActions } from '../../../../../shared/browser/browserActions.ts';

import supervisedDb from './supervisedDb.ts';
import supervisedSsh from './supervisedSsh.ts';
import type { WorkToolPolicy } from '../../../../../shared/chat/chatPermissionModes.ts';

// Одна регистрация рабочего tool: описание, доступность и вызов. Форма общая, но
// конкретные tools объявляют её каждый по-своему, поэтому список приводится один раз.
export interface WorkToolRegistration {
  descriptor: { name: string; [field: string]: unknown };
  enabled?: (options: Record<string, unknown>) => boolean;
  implicit?: readonly string[];
  invoke: (options: Record<string, unknown>, input: Record<string, unknown>) => Promise<unknown>;
}

const REGISTRATIONS = Object.freeze([
  supervisedSsh, supervisedDb, browser, help,
]) as readonly WorkToolRegistration[];

/**
 * Browser добавляет свои action limits поверх прежнего policy. У providers без
 * policy остальные tools выводятся из единственного registry, не второй таблицы имён.
 */
export function withBrowserToolPolicy(base: WorkToolPolicy | undefined, mode: string): WorkToolPolicy {
  const allowedActions: Record<string, readonly string[]> = base ? { ...base.allowedActions } : {};

  if (!base) {
    for (const registration of REGISTRATIONS) {
      const schema = registration.descriptor.inputSchema as {
        properties?: { action?: { enum?: unknown } };
      } | undefined;
      const actions = schema?.properties?.action?.enum;

      if (Array.isArray(actions) && actions.every((action) => typeof action === 'string')) {
        allowedActions[registration.descriptor.name] = [...actions];
      }
    }
  }

  const prior = base?.allowedActions.grigdesk_browser;

  allowedActions.grigdesk_browser = browserActions(mode)
    .filter((action) => !prior || prior.includes(action));

  return { revision: Math.max(2, base?.revision ?? 0), allowedActions };
}

/**
 * Справка остаётся доступной в read-only профиле, не расширяя остальные действия.
 * Новая ревизия входит в отпечаток живой сессии через существующий контракт.
 */
export function withHelpToolPolicy(base: WorkToolPolicy | undefined): WorkToolPolicy | undefined {
  if (!base) {
    return undefined;
  }

  return {
    revision: Math.max(3, base.revision), allowedActions: {
      ...base.allowedActions,
      grigdesk_help: ['index', 'search', 'read'],
    }
  };
}

/**
 * Один реестр владеет descriptor, dispatch и очисткой результата рабочих tools.
 * Ограничения action применяются и к опубликованной схеме, и независимо до брокера.
 */
export function createWorkToolRegistry(options: Record<string, unknown> & {
  workToolPolicy?: WorkToolPolicy;
} = {}) {
  const policy = options.workToolPolicy;
  const active = REGISTRATIONS.filter((registration) => (
    (!policy || Object.hasOwn(policy.allowedActions, registration.descriptor.name))
    && (typeof registration.enabled !== 'function' || registration.enabled(options))
  ));
  const byName = new Map(active.map((registration) => [registration.descriptor.name, registration]));
  const descriptors = active.map((registration) => structuredClone(registration.descriptor));

  if (policy) {
    for (const descriptor of descriptors) {
      const schema = descriptor.inputSchema as { properties: { action: { enum: readonly string[] } } };

      schema.properties.action.enum = [...policy.allowedActions[descriptor.name] || []];
    }
  }

  return {
    descriptors,
    revision: descriptors.map((descriptor) => descriptor.name).join('|'),
    /**
     * Отсутствующий descriptor не предоставляет обход server-owned action whitelist.
     * Даже вручную подставленный query/exec отклоняется до вызова брокера.
     */
    async invoke(name: unknown, input: Record<string, unknown> = {}) {
      const registration = byName.get(String(name));

      if (policy && (!registration
        || !policy.allowedActions[String(name)]?.includes(String(input?.action)))) {
        return { ok: false, error: 'action_not_allowed' };
      }

      return registration
        ? registration.invoke(options, input)
        : { ok: false, error: 'tool_not_found' };
    },
  };
}

/** Legacy-вызовы без snapshot получают базовые default-on tools из того же реестра. */
export function defaultWorkToolDescriptors(provider = '') {
  return REGISTRATIONS
    .filter((registration) => registration.implicit?.includes(provider))
    .map((registration) => structuredClone(registration.descriptor));
}

export default createWorkToolRegistry;
