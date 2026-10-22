// Очередь подтверждений принадлежит стору чата и доступна разделам через прямой alias.
// Отдельная декларация больше не скрывает реализацию от общего проекта TypeScript.
export { useChatStore as useChatApprovals } from '../stores/chat.ts';
export type { ChatPermission as ChatApproval } from './chatContracts.ts';

export interface ChatApprovalQueue {
  pending?: Record<string, import('./chatContracts.ts').ChatPermission>;
  answerPerm: (pid: string, allow: boolean, remember: boolean, comment: string, extra: string) => void;
}
