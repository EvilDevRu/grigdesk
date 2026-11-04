// Каталоги содержат только имена исходного кода, без параметров событий и данных окна.
export const WEB_SSE_SIGNALS = [
  'hello', 'plugin-event', 'state-change', 'providers-update', 'provider-install',
  'provider-install-v2', 'providers-usage', 'grigdesk-update', 'chat-permission', 'chat-question',
  'chat-permission-done', 'ssh-permission', 'ssh-sessions', 'ssh-audit', 'db-permission',
  'db-sessions', 'db-queries', 'db-audit', 'chat-step', 'chat-progress', 'chat-done', 'chat-orphan',
  'chat-turn-start', 'chat-run-metadata', 'chat-in-turn', 'chat-assistant-message', 'chat-sessions',
  'chat-session', 'chat-store', 'chat-store-meta', 'speech-settings', 'diagnostic-logging',
  'inbox-changed', 'telegram-status', 'mobile-changed', 'task-shelf-changed', 'grigdesk-tasks-changed',
  'arbiter-live', 'arbiter-conversation', 'sandboxes-changed', 'sandbox-progress', 'projects-changed',
  'onboarding-changed', 'routes-draft-changed', 'routes-catalog-changed', 'showcase-changed',
  'showcase-progress', 'showcase-build-progress', 'showcase-voice', 'usage-forecast',
  'studio-changed', 'studio-progress', 'trackers-changed',
] as const;

export const WEB_REGISTRY_REASONS = [
  'startup', 'mount', 'timer', 'sse', 'reconnect', 'credentials', 'install', 'manual', 'other',
] as const;

export const WEB_REGISTRY_OUTCOMES = [
  'start', 'joined', 'cached', 'applied', 'discarded', 'invalid', 'failed',
] as const;

export type WebRegistryReason = typeof WEB_REGISTRY_REASONS[number];

export interface WebApiTiming {
  request?: number;
  phase?: 'request' | 'headers' | 'body' | 'parse' | 'done';
  refresh?: boolean;
  status?: number;
  headersMs?: number;
  bodyMs?: number;
  parseMs?: number;
  serverMs?: number;
  chars?: number;
}
