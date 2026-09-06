export const KNOWLEDGE_SEARCH_PREFLIGHT_PROTOCOL = Object.freeze({
  name: 'cockpit.knowledge-search-preflight',
  version: 1,
});

/** Проверяет ответ отдельного probe до использования его как runtime-capability. */
export function parseKnowledgeSearchPreflight(value) {
  if (value?.protocol !== KNOWLEDGE_SEARCH_PREFLIGHT_PROTOCOL.name
    || value?.protocolVersion !== KNOWLEDGE_SEARCH_PREFLIGHT_PROTOCOL.version
    || typeof value?.report?.ok !== 'boolean'
    || !Array.isArray(value.report.checks)) {
    return {
      ok: false,
      reasonCode: 'invalid_preflight_protocol',
      checks: [],
    };
  }
  return value.report;
}
