// Только названия участков исходного кода: строки из переписки сюда не попадают.
export const WEB_PERFORMANCE_OPERATIONS = [
  'sse.decode', 'sse.dispatch', 'vue.flush', 'chat.list', 'chat.materialize',
  'chat.persist', 'chat.snapshot', 'chat.fingerprint', 'chat.put.prepare', 'chat.put.encode', 'chat.put.blob',
  'chat.timeline', 'chat.steps.fold', 'chat.steps.nest', 'markdown.lex', 'markdown.render',
  'chat.scroll', 'chat.preview', 'chat.load.parse', 'api.parse', 'providers.parse', 'board.apply', 'other',
] as const;

export type WebPerformanceOperation = typeof WEB_PERFORMANCE_OPERATIONS[number];
export type WebPerformanceBlock = 'longtask' | 'event-loop' | 'animation-frame';

export interface WebPerformanceCounts {
  chats?: number;
  messages?: number;
  steps?: number;
  chars?: number;
}
