export const stateName = (state: string) =>
  ({
    running: 'Идёт',
    waiting: 'Ждёт решения',
    stopped: 'Остановлено',
    done: 'Готово',
    idle: 'Ожидает',
  })[state] || state;

export const stageName = (status: string) =>
  ({
    done: 'Готово',
    running: 'Идёт',
    waiting: 'Ждёт',
    failed: 'Ошибка',
    idle: 'Ожидает',
  })[status] || status;

export const stageTone = (status: string) =>
  ({
    done: 'good',
    running: 'accent',
    waiting: 'warn',
    failed: 'bad',
  })[status] as 'good' | 'accent' | 'warn' | 'bad' | undefined;
