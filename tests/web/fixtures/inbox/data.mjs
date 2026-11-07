// Очередь и переписка вымышлены; визуальный тест не обращается к рабочим каналам.
// Длинные адреса и вложения проверяют переносы, а много сообщений — постоянство действий.
const firstAt = Date.parse('2026-10-24T09:15:00Z') / 1000;
const titles = [
  'После сохранения фильтра сбрасывается сортировка',
  'Не приходит письмо для восстановления пароля',
  'Добавить экспорт отчёта в CSV',
  'Ошибка при загрузке большого файла',
  'Мобильная версия: меню перекрывает форму',
  'Показывать автора изменения в истории',
  'Поиск не учитывает выбранный проект',
  'Обновить подсказку на странице оплаты',
];
const discussion = [
  ['Анна', 'После сохранения фильтра таблица сбрасывает сортировку. '
    + 'Ожидаю, что выбранный порядок строк останется.'],
  ['Михаил', 'Повторяется и при возвращении на страницу. Фильтр сохраняется, а сортировка — нет.'],
  ['Анна', 'Да, проверила в другом браузере. Прикладываю запись экрана.'],
  ['Михаил', 'Для проверки: выбрать проект, отсортировать по дате и сохранить фильтр. '
    + 'Затем открыть другой раздел и вернуться.'],
];

export const items = titles.map((title, index) => {
  const channel = index % 3 === 1 ? 'github' : 'telegram';
  const ref = `fixture-item-${index}`;
  const messages = (index ? discussion.slice(0, 1) : discussion).map(([name, text], position) => ({
    messageRef: `${ref}-message-${position}`,
    occurredAt: firstAt + position * 60,
    editedAt: null,
    author: { name },
    text: index ? title : text,
    attachments: position === 2 ? [{
      kind: 'video',
      displayLabel: 'Видео',
      name: 'filter-recording.mp4',
      size: 3_400_000,
      attachmentAnalysis: { status: 'ready', transcript: 'После сохранения сортировка сбрасывается.' },
    }] : [],
    decision: null,
  }));

  return {
    ref,
    revision: `v1_${'a'.repeat(43)}`,
    channel: { id: channel, label: channel === 'github' ? 'GitHub' : 'Telegram' },
    source: {
      title: channel === 'github' ? 'team/product · Issues' : 'Обратная связь',
      url: 'https://example.test/support',
    },
    project: 'portal',
    kind: 'bug',
    status: 'new',
    decision: null,
    firstAt: firstAt - index * 600,
    lastAt: firstAt + 180 - index * 600,
    cold: true,
    autoTask: { enabled: true, readyAtMs: 1 },
    title,
    description: messages.map((message) => `${message.author.name}: ${message.text}`).join('\n\n'),
    truncated: false,
    messages,
    attachments: [],
  };
});

export const inbox = {
  items,
  channels: ['telegram', 'github'].map((id) => ({
    id,
    label: id === 'github' ? 'GitHub' : 'Telegram',
    plugin: 'enabled',
    connection: 'connected',
    participation: 'active',
    activationVersion: 1,
    currentEpoch: 1,
    startedAtMs: firstAt * 1000,
    endedAtMs: null,
    endReason: null,
    reason: null,
    readOnly: false,
    truncated: false,
  })),
  errors: [],
  truncated: false,
  limit: null,
  worker: {
    running: true,
    readiness: 'ready',
    lastReason: '',
    lastError: null,
  },
};

export const responses = {
  '/api/inbox': inbox,
  '/api/plugins': { plugins: [{
    id: 'inbox',
    name: 'Входящие',
    enabled: true,
    nav: {
      path: '/inbox',
      label: 'Входящие',
      icon: 'inbox',
    },
  }] },
};
