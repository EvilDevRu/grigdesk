import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { tabletFixture, controlsFixture } from './tabletFixture.mjs';

export const sizes = [
  ['phone-xs', 320, 568],
  ['phone-s', 360, 640],
  ['phone-m', 360, 800],
  ['phone-l', 390, 844],
  ['phone-xl', 412, 915],
  ['phone-xxl', 430, 932],
  ['phone-land', 800, 360],
  ['phone-land-l', 915, 412],
  ['tablet-port', 800, 1280],
  ['tablet-land', 1280, 800],
  ['pad-port', 853, 1280],
  ['pad-land', 1280, 853],
  // Xiaomi Pad 7 по строке «Размер окна» экрана «Ещё» на устройстве (DPR 2.75).
  ['pad7-port', 776, 1163],
  ['pad7-land', 1163, 776],
];
export const scenarios = [
  'add-brain',
  'lock',
  'relays',
  'chats-empty',
  'chats-many',
  'chat-long',
  'chat-running',
  'chat-outbox',
  'composer-long',
  'tasks',
  'task',
  'b24-list',
  'b24-task',
  'launch-dialog',
  'more',
  'update-banner',
  'revoked',
  'offline',
  'gate-confirm',
  'chats',
  'chats-archive',
  'chats-search-empty',
  'chat-empty',
  'chat-permission',
  'permission-confirm',
  'chat-question',
  'chat-unsupported',
  'chat-stop',
  'chat-error',
  'tasks-empty',
  'tasks-error',
  'task-overview',
  'task-stop',
  'task-resume',
  'b24-empty',
  'launch-options',
  'relay-add',
  'relay-remove',
  'more-update',
  'more-reset',
  'more-operations',
  'pair-error',
  'chat-tablet',
  'chat-tablet-live',
  'chat-tablet-actions',
  'chat-tablet-layout',
  'chat-tablet-create',
  'chat-tablet-model',
  'chat-tablet-workspace',
  'chat-tablet-transfer',
  'chat-tablet-context',
];
const root = new URL('../../fixtures/mobile-contract/', import.meta.url);

/**
 * Сценарии хранятся только в tests и внедряются браузером до загрузки приложения.
 * Release graph не импортирует этот генератор или синтетические DTO.
 */
export async function fixture(name) {
  const data = {};

  for (const kind of [
    'hello',
    'chats',
    'chat',
    'waiting',
    'details',
    'tasks',
    'task',
    'plan',
    'b24-tasks',
    'b24-task',
    'launch-options',
    'app',
    'accepted',
    'gate',
    'stop',
    'resume',
    'launch',
  ]) {
    data[kind] = JSON.parse(await readFile(new URL(`v1/${kind}.json`, root), 'utf8'));
  }

  const options = {
    name,
    route: '/chats',
    data,
    state: {
      paired: true,
      unlocked: true,
      fontScale: 1,
      generation: 1,
    },
    outbox: [],
  };
  const originalWaiting = structuredClone(data.waiting);

  data.waiting.items = [];
  data.chat.messages[1].parts.unshift({
    type: 'text',
    text:
      '<img src=x onerror=alert(1)>\n' +
      'Длинный ответ агента со ссылкой и многострочным текстом. '.repeat(20),
  });
  data.chat.messages[1].parts.find((part) => part.type === 'code').text = 'x'.repeat(400);
  data.chat.messages[1].parts.push({
    type: 'image',
    ref: 'u:error-image.png',
    alt: 'Недоступная схема',
  });
  data.chat.messages[0].media.push({
    ref: 'u:pending-image.png',
    alt: 'Следующая схема',
    from: 'upload',
  });
  data.chat.chat.actions.stop = 'a'.repeat(48);
  data.plan.text =
    'План изменений\n\n' + 'Полное основание с длинными словами: ' + 'ВажнаяПроверка'.repeat(100);
  data['b24-task'].task.description =
    '<b>Описание как текст</b>\n' + 'Подробное описание задачи. '.repeat(100);
  data['launch-options'].options = [
    {
      id: 'route-a',
      title: 'Обычный запуск',
      disabledReason: null,
    },
  ];
  data['launch-options'].actionToken = 'b'.repeat(48);

  if (name === 'add-brain') {
    options.state.paired = false;
    options.state.unlocked = false;
  } else if (name === 'lock' || name === 'revoked') {
    options.state.unlocked = false;
    options.state.revoked = name === 'revoked';
  } else if (name === 'relays') {
    options.route = '/relays';
    options.state.relays = ['online', 'offline', 'connecting', 'waiting_vpn'].map(
      (state, index) => ({
        id: `r${index}`,
        name: 'Посредник с очень длинным именем ' + 'ДлинноеИмя'.repeat(8),
        host: 'example.invalid',
        port: 443,
        state,
      }),
    );
    options.state.activeRelayId = 'r0';
  } else if (name === 'chats-empty') {
    data.chats.chats = [];
  } else if (name === 'chats-many') {
    data.chats.chats = Array.from({ length: 50 }, (_, index) => ({
      ...data.chats.chats[0],
      id: `chat${index}`,
      title: 'Очень длинный заголовок разговора ' + 'abcdefghij'.repeat(10),
      state: index % 3 === 0 ? 'running' : index % 3 === 1 ? 'queued' : 'idle',
      waiting: index % 5,
    }));
  } else if (name.startsWith('chat-') || name === 'composer-long') {
    options.route = '/chats/' + data.chat.chat.id;

    if (name === 'chat-long') {
      data.waiting.items = [
        {
          pid: 'p-visual',
          chatId: data.chat.chat.id,
          kind: 'permission',
          tool: 'Bash',
          summary: 'Разрешить проверку проекта',
          details: 'Полные аргументы команды',
          acceptsComment: true,
          canRemember: false,
          contentRevision: 'a'.repeat(64),
          hasMore: false,
          nextOffset: null,
          actionToken: 'a'.repeat(48),
        },
        {
          pid: 'q-visual',
          chatId: data.chat.chat.id,
          kind: 'question',
          prompt: 'Выберите варианты и добавьте текст',
          structured: false,
          actions: ['accept', 'cancel'],
          actionToken: 'b'.repeat(48),
          questions: [
            {
              id: 'q1',
              header: 'Варианты',
              question: 'Какие проверки выполнить?',
              multiSelect: true,
              allowFreeText: true,
              inputType: 'multi-choice',
              required: true,
              constraints: {},
              options: Array.from({ length: 6 }, (_, index) => ({
                id: `o${index}`,
                label: `Проверка ${index + 1}`,
                description: 'Подробное описание проверки для принятия решения пользователем',
              })),
            },
          ],
        },
      ];
    }
    if (name === 'chat-running') {
      data.chat.chat.state = 'running';
    }
    if (name === 'chat-outbox') {
      options.outbox = [1, 2].map((index) => ({
        method: 'POST',
        path: '/api/mobile/v1/chats/' + data.chat.chat.id + '/messages',
        body: JSON.stringify({
          text: `Сообщение ${index}`,
          clientId: `client-pending-${index}`,
        }),
        idempotencyKey: `operation-pending-${index}`,
        createdAt: Date.now(),
        clientId: `client-pending-${index}`,
        chatId: data.chat.chat.id,
      }));
    }
  } else if (name === 'tasks') {
    options.route = '/tasks';
    data.tasks.tasks.push({
      ...data.tasks.tasks[0],
      id: '199',
      title: 'Другое ожидание',
      needsHuman: {
        kind: 'other',
        gate: null,
        text: 'Решение доступно в кокпите',
        actionToken: null,
      },
    });
  } else if (name === 'task' || name === 'gate-confirm') {
    options.route = '/tasks/' + data.task.task.id;
  } else if (name === 'b24-list') {
    options.route = '/b24';
  } else if (name === 'b24-task' || name === 'launch-dialog') {
    options.route = '/b24/' + data['b24-task'].task.id;
  } else if (name === 'more') {
    options.route = '/more';
  } else if (name === 'update-banner') {
    data.hello.minApp = '9.0.0';
  }

  // Обычные сценарии читаются глазами; длинные и повреждённые данные выше остаются
  // отдельными стресс-кадрами. Подтверждения здесь только открываются, без мутаций.
  if (['chats', 'chats-archive', 'chats-search-empty'].includes(name)) {
    data.chats.chats = [
      ['Дизайн мобильного приложения', 'running', 0],
      ['Проверка перед выпуском', 'idle', 1],
      ['Обновление документации', 'idle', 0],
      ['Задачи на неделю', 'queued', 0],
    ].map(([title, state, waiting], index) => ({
      ...data.chats.chats[0],
      id: `chat-${index}`,
      title,
      state,
      waiting,
      archived: name === 'chats-archive' && index === 2,
      updatedAt: Date.now() - index * 1800000,
    }));
  }
  if ([
    'chat-empty', 'chat-permission', 'permission-confirm', 'chat-question',
    'chat-unsupported', 'chat-stop', 'chat-error',
  ].includes(name)) {
    options.route = '/chats/' + data.chat.chat.id;
    data.chat.chat.title = 'Дизайн мобильного приложения';
    data.chat.hasMore = false;
    data.chat.messages = name === 'chat-empty' ? [] : data.chat.messages.map((message) => ({
      ...message,
      media: [],
      parts: [{
        type: 'text',
        text: message.role === 'user'
          ? 'Проверь экраны приложения и приблизь их к Кокпиту.'
          : 'Проверил навигацию, списки и карточки задач. Поиск и состояния ожидания теперь ' +
            'устроены как в Кокпите. Дальше проверю диалоги и увеличенный шрифт.',
      }],
    }));

    if (['chat-permission', 'permission-confirm', 'chat-question', 'chat-unsupported'].includes(name)) {
      const kind = name === 'chat-question' ? 'question'
        : name === 'chat-unsupported' ? 'unsupported' : 'permission';

      data.waiting.items = originalWaiting.items.filter((item) => item.kind === kind)
        .map((item) => ({
          ...item,
          chatId: data.chat.chat.id,
        }));

      if (kind === 'unsupported') {
        data.waiting.items = [{
          pid: 'unsupported-visual',
          chatId: data.chat.chat.id,
          kind: 'unsupported',
          reason: 'Это действие требует решения в Кокпите на компьютере.',
        }];
      }
    }
    if (name === 'chat-stop') {
      data.chat.chat.state = 'running';
    }
  }
  if (name.startsWith('tasks-')) {
    options.route = '/tasks';

    if (name === 'tasks-empty') {
      data.tasks.tasks = [];
    }
  }
  if (['task-overview', 'task-stop', 'task-resume'].includes(name)) {
    options.route = '/tasks/' + data.task.task.id;
    data.task.task.title = 'Привести мобильные экраны к дизайну Кокпита';
    data.task.task.actions.stop = 'a'.repeat(48);
    data.task.task.actions.resume = 'b'.repeat(48);
  }
  if (name === 'b24-empty') {
    options.route = '/b24';
    data['b24-tasks'].tasks = [];
  }
  if (name === 'launch-options') {
    options.route = '/b24/' + data['b24-task'].task.id;
    data['b24-task'].task.description = 'Проверить выпуск приложения на телефоне и планшете.';
    data['launch-options'].options.push({
      id: 'route-review',
      title: 'Запуск с проверкой',
      disabledReason: null,
    }, {
      id: 'route-disabled',
      title: 'Маршрут с ревью',
      disabledReason: 'Исполнитель этого маршрута недоступен.',
    });
  }
  if (name === 'relay-add' || name === 'relay-remove') {
    options.route = name === 'relay-add' ? '/relays/add' : '/relays';
  }
  if (name.startsWith('more-')) {
    options.route = '/more';

    if (name === 'more-operations') {
      options.outbox = [{
        method: 'POST',
        path: '/api/mobile/v1/tasks/101/stop',
        body: '{}',
        idempotencyKey: 'operation-unconfirmed',
        createdAt: Date.now(),
      }];
    }
    if (name === 'more-update') {
      data.app.version = '9.0.0';
    }
  }
  if (name === 'pair-error') {
    options.state.paired = false;
    options.state.unlocked = false;
    options.state.error = 'Срок действия кода истёк. Создайте новый код в настройках Кокпита.';
  }

  const directory = new URL(`visual/${name}/`, root);

  await mkdir(directory, { recursive: true });
  await writeFile(new URL('scenario.json', directory), JSON.stringify(options, null, 2) + '\n');

  if (name.startsWith('chat-tablet')) {
    tabletFixture(options);
  }

  controlsFixture(data);

  return options;
}
