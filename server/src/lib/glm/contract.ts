import { canonicalJson as canonicalGlmJson } from '../../../../shared/lib/canonicalJson.ts';
import {
  glmCompatibilityHash,
  type GlmCompatibilityRuntime,
} from '../../../../shared/node/glmCompatibility.ts';

export { canonicalGlmJson };

export type GlmAccessMode = 'api' | 'coding-plan';

export type { GlmCompatibilityRuntime };

export const GLM_PROFILE_REVISION = 'grigdesk-glm-profile-v3';
export const GLM_POLICY_REVISION = 'grigdesk-glm-policy-v2';
// Ревизии отвязанного этапа фабрики отдельны от чата: смена Factory профиля или политики
// не меняет отпечаток, допуск и память обычного чата GLM.
export const GLM_FACTORY_PROFILE_REVISION = 'grigdesk-glm-factory-profile-v1';
export const GLM_FACTORY_POLICY_REVISION = 'grigdesk-glm-factory-policy-v1';
export const GLM_DEFAULT_EFFORT = 'high';
export const GLM_ALLOWED_MODES: readonly GlmAccessMode[] = Object.freeze(['api', 'coding-plan']);

// Факты G2 на настоящей generation. Инструменты профиля, которые hook разрешает по точному
// имени: без делегирующих, субагентных, workflow, jobs, goal, plan, skill и web-инструментов.
export const GLM_NATIVE_TOOLS: readonly string[] = Object.freeze([
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'bash',
  'todo_write',
  'ask_user_question',
]);

// Ошибка модели приходит в turn/end как reason.error.code; HTTP-статуса нет.
// Остальные коды (RATE_LIMIT, TRANSPORT, SERVER и др.) — сбой доставки хода.
export const GLM_MODEL_ERROR_CODES: Readonly<Record<string, string>> = Object.freeze({
  AUTH: 'glm_auth_failed',
  QUOTA: 'glm_quota_exhausted',
});

// Web-RPC сессии DSH: выбор модели с effort и обратное чтение через snapshot follow
// (`projections.values.modelSelection.next`). Неподдерживаемый выбор — этот код ошибки.
export const GLM_SELECT_MODEL_RPC = 'session/selectModel';
export const GLM_MODEL_UNAVAILABLE = 'session/model-unavailable';

// ACP: модель и уровни читаются из configOptions; пустое значение effort — «Provider default».
export const GLM_ACP_MODEL_CONFIG = 'model';
export const GLM_ACP_EFFORT_CONFIG = 'reasoning_effort';

// Имя MCP-инструмента в DSH: длина и хвост хэша по формуле dsh-mcp-client.
export const GLM_MCP_NAME_LIMIT = 64;
export const GLM_MCP_HASH_LENGTH = 12;

/**
 * Режим доступа задаёт человек в окружении службы.
 * Неизвестное значение не превращается в неявный выбор режима.
 */
export function parseGlmAccessMode(value: unknown): GlmAccessMode | null {
  return value === 'api' || value === 'coding-plan' ? value : null;
}

/**
 * Один маршрут zai обслуживает оба режима доступа.
 * Адрес Coding Plan остаётся встроенным адресом библиотеки pi-ai.
 */
export function buildGlmRoute(mode: GlmAccessMode): Record<string, unknown> {
  return {
    ...(mode === 'api' ? { baseURL: 'https://api.z.ai/api/paas/v4' } : {}),
    apiKeyEnv: 'GRIGDESK_GLM_ROUTE_KEY',
    // Сеть до Z.ai нестабильна: dsh-llm-retry повторяет запрос к модели при обрыве, 429, 5xx и
    // таймауте (коды по умолчанию). Это повтор запроса, а не хода: инструменты не выполнялись.
    retryPolicy: {
      mode: 'normal',
      maxRetries: 10,
    },
    // У glm-4.7 и glm-5-turbo нет reasoning_effort на wire: все уровни дают одно и то же
    // thinking enabled, поэтому выбор уровня не предлагается — только high.
    modelOverrides: {
      'glm-4.7': { reasoningEfforts: { high: 'high' } },
      'glm-5-turbo': { reasoningEfforts: { high: 'high' } },
    },
  };
}

/**
 * Допуск относится к входам runtime и политике GLM.
 * Платформа, путь и buildId не являются входами этого отпечатка.
 */
export function glmCompatibilityIdentity(
  runtime: GlmCompatibilityRuntime,
  mode: GlmAccessMode,
  revisions = { profile: GLM_PROFILE_REVISION, policy: GLM_POLICY_REVISION },
): string {
  return glmCompatibilityHash(runtime, mode, revisions);
}

/**
 * Ключ режима выбирается только из его собственной переменной службы.
 * Другие модельные ключи никогда не становятся запасным источником.
 */
export function selectGlmServiceKey(
  mode: GlmAccessMode,
  env: Record<string, string | undefined>,
): string | null {
  const name = mode === 'api' ? 'ZAI_API_KEY' : 'ZAI_CODING_API_KEY';

  return env[name] || null;
}
