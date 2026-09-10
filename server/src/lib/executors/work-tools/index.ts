import knowledgeSearch from './knowledgeSearch.ts';
import supervisedDb from './supervisedDb.ts';
import supervisedSsh from './supervisedSsh.ts';

// Одна регистрация рабочего tool: описание, доступность и вызов. Форма общая, но
// конкретные tools объявляют её каждый по-своему, поэтому список приводится один раз.
export interface WorkToolRegistration {
  descriptor: { name: string; [field: string]: unknown };
  enabled?: (options: Record<string, unknown>) => boolean;
  implicit?: readonly string[];
  invoke: (options: Record<string, unknown>, input: Record<string, unknown>) => Promise<unknown>;
}

const REGISTRATIONS = Object.freeze([
  supervisedSsh, knowledgeSearch, supervisedDb,
]) as readonly WorkToolRegistration[];

/** Один реестр владеет descriptor, dispatch и очисткой результата рабочих tools. */
export function createWorkToolRegistry(options = {}) {
  const active = REGISTRATIONS.filter((registration) => (
    typeof registration.enabled !== 'function' || registration.enabled(options)
  ));
  const byName = new Map(active.map((registration) => [registration.descriptor.name, registration]));
  const descriptors = active.map((registration) => structuredClone(registration.descriptor));

  return {
    descriptors,
    revision: descriptors.map((descriptor) => descriptor.name).join('|'),
    async invoke(name: unknown, input: Record<string, unknown> = {}) {
      const registration = byName.get(String(name));
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
