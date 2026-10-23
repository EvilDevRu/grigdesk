/**
 * Внешние SSH/БД/Docker отвечают только синтетическими server-owned DTO.
 * Настоящие панели, их декодеры, actions и WebSocket lifecycle не подменяются.
 */
export async function installServices(context) {
  const state = {

    sockets: [],

    closedSessions: [],

    sshLabel: 'SSH до события',

    dbLabel: 'БД до события',

    queries: [],

  };
  const ssh = () => ({

    id: 'ssh-a',

    connectionId: 'connection-a',

    projectId: 'demo',

    label: state.sshLabel,

    role: 'code',

    host: 'fixture.invalid',

    port: 22,

    user: 'fixture',

    agentAllowed: false,

    generation: 1,

    openedAt: '2026-08-26T08:00:00.000Z',

  });
  const db = () => ({

    id: 'db-a',

    profileId: 'profile-a',

    projectId: 'demo',

    label: state.dbLabel,

    role: 'read',

    engine: 'mysql',

    prod: false,

    via: 'direct',

    agentAllowed: false,

    generation: 1,

    readOnlyActive: true,

    openedAt: '2026-08-26T08:00:00.000Z',

  });
  const container = {

    id: 'container-a',

    shortId: 'container-a',

    name: 'fixture-container',

    image: 'fixture',

    imageId: 'fixture-image',

    command: 'sh',

    createdAt: null,

    state: 'running',

    status: 'Up',

    health: '',

    ports: [],

    networks: [],

    mounts: [],

    sizeRw: null,

    compose: null,

  };

  await context.route('**/api/ssh/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let result = {};

    if(request.method() === 'DELETE') {
      state.closedSessions.push(url.pathname);
    }
    if(url.pathname.endsWith('/connections')) {
      result = { connections: [] };
    } else if(url.pathname.endsWith('/sessions')) {
      result = { sessions: [ssh()] };
    } else if(url.pathname.endsWith('/files')) {
      result = { files: [] };
    } else if(url.pathname.endsWith('/audit')) {
      result = { items: [] };
    }

    await route.fulfill({ json: result });
  });
  await context.route('**/api/db/**', async (route) => {
    const url = new URL(route.request().url());
    let result = {};

    if(url.pathname.endsWith('/engines')) {
      result = { engines: [{ id: 'mysql', label: 'MySQL' }] };
    } else if(url.pathname.endsWith('/profiles')) {
      result = { profiles: [] };
    } else if(url.pathname.endsWith('/sessions')) {
      result = { sessions: [db()] };
    } else if(url.pathname.endsWith('/queries')) {
      result = { queries: state.queries };
    } else if(url.pathname.endsWith('/audit')) {
      result = { items: [] };
    } else if(url.pathname.endsWith('/schema')) {
      result = {
        schema: {

          rows: [],

          shownRows: 0,

          totalRows: 0,

          shownBytes: 0,

          totalBytes: 0,

          truncated: false,

          untrusted: true,

        }
      };
    }

    await route.fulfill({ json: result });
  });
  await context.route('**/api/docker/**', async (route) => {
    const url = new URL(route.request().url());
    const result = url.pathname.endsWith('/health') ? {

      available: true,

      version: 'fixture',

      apiVersion: '1',

      socketPath: '/fixture/docker.sock',

    } : {

      containers: [container],

      projects: [],

      images: [],

      volumes: [],

      networks: [],

      counts: {

        containers: 1,

        running: 1,

        images: 0,

        volumes: 0,

        networks: 0

      },

    };

    await route.fulfill({ json: result });
  });
  await context.routeWebSocket(/\/api\/(ssh|docker)\//, (socket) => {
    const record = {

      socket,

      url: socket.url(),

      closed: false,

      sent: []

    };

    state.sockets.push(record);
    socket.onClose(() => {
      record.closed = true;
    });
    socket.onMessage((message) => record.sent.push(message));

    if(record.url.includes('/ssh/')) {
      socket.send('Синтетическая SSH-сессия\r\n');
    }
  });

  return state;
}

/**
 * Только пользовательские устройства уведомлений и звука заменены счётчиками.
 * Окно по-прежнему должно само решить, создавать ли уведомление и воспроизводить ли звук.
 */
export async function observeAlerts(context) {
  await context.addInitScript(() => {
    window.__toolAlerts = { notifications: 0, sounds: 0 };
    window.Notification = class {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      constructor() {
        window.__toolAlerts.notifications += 1;
      }
      close() { }
      addEventListener() { }
    };

    const originalPlay = HTMLMediaElement.prototype.play;

    HTMLMediaElement.prototype.play = function() {
      window.__toolAlerts.sounds += 1;

      return Promise.resolve();
    };
    document.hasFocus = () => false;
  });
}
