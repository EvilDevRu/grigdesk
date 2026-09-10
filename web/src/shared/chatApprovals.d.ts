// Объявление моста к очереди подтверждений: что именно раздел вправе спросить у чата.
//
// Файл рядом с `chatApprovals.js` описывает его для TypeScript. Ограничение здесь
// намеренное: раздел видит очередь спросов и один способ ответить, а до остального
// состояния чата не дотягивается — ни типами, ни случайным обращением.

export interface ChatApproval {
  pid: string;
  origin?: string;
  kind?: string;
  chatKey?: string;
  tool?: string;
  command?: string;
  user?: string;
  isRoot?: boolean;
  usesSudo?: boolean;
  server?: {
    label?: string;
    host?: string;
    port?: number;
  };
}

export interface ChatApprovalQueue {
  pending?: Record<string, ChatApproval>;
  answerPerm: (
    pid: string,
    allow: boolean,
    remember: boolean,
    comment: string,
    extra: string,
  ) => void;
}

export declare function useChatApprovals(): ChatApprovalQueue;
