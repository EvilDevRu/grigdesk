// Ответ отдельного probe: пока протокол и форма не совпали, это не возможность
// среды, а «проверить не удалось» — и решение принимается по отказу, а не молча.
export interface KnowledgePreflightReport {
  ok: boolean;
  reasonCode?: string;
  checks: unknown[];
}

export const KNOWLEDGE_SEARCH_PREFLIGHT_PROTOCOL = Object.freeze({
  name: 'cockpit.knowledge-search-preflight',
  version: 1,
});

/** Проверяет ответ отдельного probe до использования его как runtime-capability. */
export function parseKnowledgeSearchPreflight(source: unknown): KnowledgePreflightReport {
  const value = source as {
    protocol?: unknown;
    protocolVersion?: unknown;
    report?: KnowledgePreflightReport;
  } | null;

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
