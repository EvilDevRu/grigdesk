// Единственная точка входа общего Inbox для оболочки: состояние счётчика берётся
// из стора, а запрос, таймер перепроверки и подписка на события — из операций.
export { useInboxStore } from '../../stores/inbox.ts';

export {
  refreshInboxSummary,
  startInboxSummary,
  stopInboxSummary,
} from './watchInboxSummary.ts';
