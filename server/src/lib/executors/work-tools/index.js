import knowledgeSearch from './knowledge-search.js';
import supervisedDb from './supervised-db.js';
import supervisedSsh from './supervised-ssh.js';

const REGISTRATIONS = Object.freeze([supervisedSsh, knowledgeSearch, supervisedDb]);

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
    async invoke(name, input = {}) {
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
