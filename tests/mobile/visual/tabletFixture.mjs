/**
 * Кадр планшета повторяет структуру эталонного веб-разговора на синтетических данных.
 * В нём есть разные исполнители, работающий соседний чат, превью, Markdown и действия.
 */
export function tabletFixture(options) {
  const { data, name } = options;
  const provider = {
    id: 'codex',
    name: 'GPT (Codex)',
    color: '#10a37f',
  };
  const titles = [
    'Дизайн мобильного GrigDesk',
    'Проверка перед выпуском',
    'Обновление документации',
    'План работ на неделю',
    'Сравнение экранов',
    'Новый разговор',
  ];

  data.chats.chats = titles.map((title, index) => ({
    ...data.chats.chats[0],
    id: index ? `tablet-chat-${index}` : data.chat.chat.id,
    title,
    provider: index % 2 ? {
      id: 'claude',
      name: 'Claude',
      color: '#d97757',
    } : provider,
    model: index % 2 ? 'Opus 5.5' : 'GPT-6',
    preview: ['Проверил портрет и альбомную ориентацию.', 'Ты: проверь приложение на планшете.',
      'Подготовил список изменений.', 'В очереди', 'Покажи оба варианта.', 'Пустой чат'][index],
    waiting: index === 2 ? 1 : 0,
    state: index < 2 ? 'running' : index === 3 ? 'queued' : 'idle',
    updatedAt: Date.now() - index * 120000,
  }));
  data.chats.hasMore = false;
  data.chat.chat = {
    ...data.chat.chat,
    ...data.chats.chats[0],
    state: name === 'chat-tablet-live' ? 'running' : 'idle',
    effort: 'high',
  };
  data.chat.chat.modelRef = { provider: 'codex', model: 'gpt-6' };
  data.chat.hasMore = false;

  if (data.chat.chat.state === 'idle') {
    data.chat.chat.actions = { configure: 'c'.repeat(48) };
    data.chats.chats[0].state = 'idle';
  }

  data.chat.messages = data.chat.messages.slice(0, 2).map((message) => ({
    ...message,
    media: [],
    parts: [{
      type: 'text',
      text: message.role === 'user'
        ? 'Проверь приложение на планшете: список, разговор и работу агента.'
        : '**Планшетная раскладка обновлена.** Список и разговор видны рядом в обеих ориентациях.\n\n' +
          '- У работающего чата вращается кольцо вокруг значка исполнителя.\n' +
          '- Действия и размышления можно раскрыть прямо в ленте.\n' +
          '- Черновик сохраняется при переключении между разговорами.\n\n' +
          '| Режим | Список и разговор |\n| --- | --- |\n| Портрет | Две колонки |\n' +
          '| Альбомный | Две колонки |\n\n' +
          'Проверено при обычном и увеличенном шрифте. Следующий шаг — проверка на устройстве.',
    }],
  }));

  const activity = {
    items: [
      {
        id: 'think-1',
        kind: 'think',
        title: 'Размышление',
        text: 'Проверю ширину обеих колонок и сохранение места чтения.',
        result: '',
        state: 'done',
        at: Date.now() - 5000,
      },
      {
        id: 'read-1',
        kind: 'tool',
        title: 'Read',
        text: 'mobile/src/styles/layout.css',
        result: 'Раскладка планшета прочитана.',
        state: 'done',
        at: Date.now() - 4000,
      },
      {
        id: 'test-1',
        kind: 'tool',
        title: 'Bash',
        text: 'npm --prefix mobile run test',
        result: 'Проверки пройдены.',
        state: 'done',
        at: Date.now() - 3000,
      },
    ],
    omitted: 0,
  };

  data.chat.messages[1].activity = activity;
  options.route = '/chats/' + data.chat.chat.id;

  if (name === 'chat-tablet-live') {
    data.chat.activity = structuredClone(activity);
    data.chat.activity.items.at(-1).state = 'running';
    data.chat.activity.items.at(-1).result = '';
    data.chat.messages = data.chat.messages.slice(0, 1);
  }
}

/**
 * Расширение v1 проверяется отдельной фикстурой; замороженные ответы старого сервера не меняются.
 * Модели, папки, контекст и счётчики здесь синтетические и не читаются из профиля разработчика.
 */
export function controlsFixture(data) {
  data.hello.features = ['chat-controls', 'attention'];
  data['chat-options'] = {
    models: [
      {
        provider: 'codex',
        providerName: 'GPT (Codex)',
        id: 'gpt-6',
        name: 'GPT-6',
        efforts: ['low', 'medium', 'high', 'max'],
        context: 200000,
        contextVerified: true,
        autoCompact: true,
        available: true,
      },
      {
        provider: 'claude',
        providerName: 'Claude',
        id: 'opus',
        name: 'Opus',
        efforts: ['low', 'high'],
        context: 200000,
        contextVerified: true,
        autoCompact: false,
        available: true,
      },
    ],
    defaultModelRef: { provider: 'codex', model: 'gpt-6' },
    tasks: [{ id: '123', title: 'Проверить интерфейс на планшете' }],
    projects: [{ id: 'sample', title: 'Демонстрационный проект' }],
    tasksOmitted: 0,
    projectsOmitted: 0,
  };
  data.attention = {
    chats: {
      waiting: 2,
      unread: 3,
      running: 1,
    },
    tasks: {
      waiting: 1,
      stalled: 1,
      running: 2,
    },
  };
  data['workspace-preview'] = {
    directory: '/workspace/sample',
    previousDirectory: '/workspace/grigdesk',
    transfer: 'reseed',
    summaryAvailable: true,
    warnings: [],
    actionToken: 'w'.repeat(48),
  };
  data.chat.chat.modelRef = { provider: 'codex', model: 'gpt-6' };
  data.chat.chat.settings = {
    modelRef: data.chat.chat.modelRef,
    workdir: { kind: 'grigdesk' },
    directory: '/workspace/grigdesk',
    context: {
      tokens: 62000,
      window: 200000,
      metric: 'last-request-input',
      estimate: false,
      live: data.chat.chat.state === 'running',
      compactWindow: 0,
    },
  };

  if (data.chat.chat.state === 'idle') {
    data.chat.chat.actions.configure = 'c'.repeat(48);
  }
}
