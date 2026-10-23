// Снимок фоновых задач принадлежит процессу, а не отдельному ходу или истории чата.
// Адаптер убирает служебные поля исполнителя до передачи этого контракта ядру и окнам.
export interface ChatBackgroundTask {
  id: string;
  kind: 'subagent' | 'monitor' | 'command' | 'other';
  description: string;
}

export interface ChatSleepingSession {
  chatKey: string;
  alive: boolean;
  sleeping: boolean;
  backgroundTasks: ChatBackgroundTask[];
}
