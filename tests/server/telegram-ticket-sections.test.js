// Секция «Обсуждение в Telegram» в постановке конвейера.
//
// Вторая точка встройки разворота. Карточка задачи показывает переписку
// человеку, а тикет — агенту: без неё первый же этап читает описание вида
// «см. обсуждение https://t.me/c/…» и идёт переспрашивать то, что уже сказано.
//
// Четыре обещания, ради которых тест написан раньше кода:
//
//  • ЛИМИТ применяется ДО сборки тикета. Секции дописываются в хвост описания,
//    а `fitDescription` режет описание с КОНЦА — то есть обсуждение обрезалось бы
//    первым и молча. Значит объём ограничивает `buildDiscussion`, а не подрезка
//    при сборке (docs/cockpit/inbox.md, раздел «Telegram»);
//  • граница проекта работает и здесь. Профиль прогона — это и есть проект,
//    поэтому чат, привязанный к ЧУЖОМУ проекту, в постановку не попадает: иначе
//    ссылка в описании вытягивала бы переписку соседнего проекта прямо агенту;
//  • ссылку ищем во всей постановке, а не только в описании: её любят вписать
//    комментарием в трекере, и это самое частое место;
//  • разворот не имеет права сорвать запуск. Выключенный плагин, сломанный
//    архив, молчащий Телеграм — конвейер стартует, просто без секции.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import factoryModule from '../../server/src/modules/factory/index.ts';
import telegramModule from '../../server/src/modules/telegram/index.ts';
import { TelegramArchiveStore } from '../../server/src/lib/telegram/archiveStore.ts';
import {
  TelegramModuleCredentials,
  telegramModuleConnection,
} from './helpers/telegram-account-module.js';
import { TelegramRulesStore } from '../../server/src/lib/telegram/rulesStore.ts';
import { parsePipeline } from '../../server/src/lib/pipelineParse.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const ATTEMPT = 'a_0123456789abcdef0123456789abcdef';
const ROUTE_HASH = 'a'.repeat(64);

const TOKEN = '8123456789:AAHrEaLLyLoNgSeCrEtPaRt_x1y2z3w4v5u6';
const BUGS = -1001234567890;
const T0 = Date.UTC(2026, 7, 1, 9, 0, 0) / 1000;

const ME = {
  id: 8123456789,
  username: 'example_inbox_bot',
  firstName: 'Кокпит · входящие',
  canJoinGroups: true,
  canReadAllGroupMessages: true,
};

const SECRET = 'касса не пробивает чек с прошлой пятницы, платёж 4412';
const link = (chatId, id) => `https://t.me/c/${String(chatId).replace('-100', '')}/${id}`;

const msg = (over = {}) => ({
  chatId: BUGS,
  chatUsername: '',
  chatTitle: 'Кокпит · баги',
  chatType: 'supergroup',
  isForum: false,
  messageId: 100,
  threadId: null,
  replyToMessageId: null,
  date: T0,
  editedAt: null,
  from: { id: 7, name: 'Аня', username: 'anya' },
  text: SECRET,
  media: [],
  ...over,
});

const logStub = () => ({ warn() {}, error() {}, info() {}, debug() {} });

/**
 * Стенд запуска: заглушки движка и systemd те же, что в `factory-launch-runner`,
 * плюс живой модуль telegram со своим архивом и правилами. Проверяем именно
 * файл тикета — то, что реально прочитает движок, а не промежуточный объект.
 */
async function fixture(t, {
  enabled = true,
  messages = [],
  rules: ruleList = [{ project: 'demo', chatId: BUGS }],
  archive: archiveStub = null,
  comments = [],
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-ticket-tg-'));
  const stateDir = path.join(root, 'state');
  const profilesDir = path.join(root, 'profiles');
  const binDir = path.join(root, 'bin');
  const runnersDir = path.join(root, 'engine', 'lib', 'runners');
  await Promise.all([
    mkdir(stateDir, { recursive: true }),
    mkdir(path.join(profilesDir, 'demo'), { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(runnersDir, { recursive: true }),
  ]);
  await writeFile(path.join(runnersDir, 'claude.sh'), '# адаптер\n');
  await writeFile(path.join(profilesDir, 'demo', 'runners.env'), [
    'RUNNERS_SCHEMA=1', 'CONFIG_REVISION=1', 'PROJECT_RUNNER_PRIMARY=claude', '',
  ].join('\n'));
  await writeFile(path.join(profilesDir, 'demo', 'profile.sh'), `
PROFILE_TRIAGE_REPOS=""
profile_repositories() { printf 'demo\\t${root}/src\\t${root}/work\\n'; }
`);

  const factoryBin = path.join(binDir, 'factory');
  await writeFile(factoryBin, `#!/usr/bin/env bash
case "$1" in
  check) echo "OK profile=demo catalog=${'b'.repeat(64)} route=feature delivery=disabled instrumentation=disabled"; exit 0 ;;
  slots) echo '{"supported":false,"reason":"тест без слотов"}'; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });

  await writeFile(path.join(binDir, 'systemd-run'), `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "systemd 252 (test)"; exit 0; fi
seen=""; task=""
for a in "$@"; do
  if [ -n "$seen" ]; then task="$a"; break; fi
  if [ "$a" = "${factoryBin}" ]; then seen=1; fi
done
[ -n "$task" ] || exit 1
bash -c 'sleep 30; :' "${factoryBin}" "$task" </dev/null >/dev/null 2>&1 &
pid=$!
echo "$pid" >> "${path.join(root, 'daemon.pids')}"
cat > "${stateDir}/t$task.pipeline" <<EOF
PROFILE=demo
ROUTE=feature
RUN_PROTOCOL=2
CATALOG_PROTOCOL=route-v2
CATALOG_HASH=${'b'.repeat(64)}
ATTEMPT_ID=${ATTEMPT}
ROUTE_HASH=${ROUTE_HASH}
QUEUE_DISPATCH_ID=
RUNNER_OVERRIDE_PRIMARY=
DELIVERY_MODE=disabled
ORCH_PID=$pid
STALLED_HUMAN=0
WF_STATUS=running
EOF
exit 0
`, { mode: 0o755 });
  await writeFile(path.join(binDir, 'systemctl'), '#!/usr/bin/env bash\necho active\nexit 0\n', { mode: 0o755 });

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });

  const creds = new TelegramModuleCredentials();
  creds.write({ token: TOKEN, bot: ME });
  const store = new TelegramArchiveStore({ dir: path.join(root, 'tg'), log: logStub() });
  for (const m of messages) await store.append(m);
  const rules = new TelegramRulesStore({ dir: path.join(root, 'tg-rules'), log: logStub() });
  await rules.write(ruleList, { projects: ['demo', 'alpha'] });

  const config = {
    factoryHome: path.join(root, 'engine'),
    factoryBin,
    factoryConfigRoot: path.join(root, 'config'),
    factoryControlDir: path.join(root, 'control'),
    routesDir: path.join(root, 'routes'),
    ticketsDir: path.join(root, 'tickets'),
    stateDir,
    profilesDir,
    factoryProfile: 'demo',
  };

  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => enabled);
  // Порядок регистрации — как в app.js: factory раньше telegram. Декоратор
  // нужен в момент запроса, и порядок на это влиять не должен.
  await app.register(factoryModule, {
    factoryState: {
      discoverProfiles() { return ['demo']; },
      async primaryProfile() { return 'demo'; },
      async readRegistry(id) {
        return { registry: parsePipeline(await readFile(path.join(stateDir, `t${id}.pipeline`), 'utf8')) };
      },
      isDaemonAlive(orchPid, task) {
        try {
          const argv = readFileSync(`/proc/${Number(orchPid)}/cmdline`, 'utf8').split('\0').filter(Boolean);
          return argv.some((a) => a.endsWith('/bin/factory')) && argv.includes(String(task));
        } catch { return false; }
      },
      async catalog(profile) {
        return profile === 'demo'
          ? {
            routes: ['feature'],
            catalogHash: 'b'.repeat(64),
            routeOptions: {
              feature: {
                deliveryMode: 'disabled', instrumentationMode: 'disabled', instrumentationRequired: false,
              },
            },
          }
          : null;
      },
    },
    config,
    prefs: { read: () => ({}) },
    b24: comments.length ? { taskPageData: async () => ({ comments }) } : null,
    analyzer: { readClarifications: async () => null, readOpenQuestions: async () => null, async get() { return null; } },
  });
  const nativeBotApi = {
    getMe: async () => ME,
    callBotApi: async () => { throw new Error('сеть в тесте не нужна'); },
  };
  const connection = telegramModuleConnection({
    creds, archive: archiveStub ?? store, rules, botApi: nativeBotApi,
  });
  await app.register(telegramModule, {
    connection,
    botApi: nativeBotApi,
    listProjects: async () => ['demo', 'alpha'],
  });
  await app.ready();

  t.after(async () => {
    await app.close();
    const pids = await readFile(path.join(root, 'daemon.pids'), 'utf8').catch(() => '');
    for (const pid of pids.split('\n').filter(Boolean)) {
      try { process.kill(Number(pid)); } catch { /* уже ушёл */ }
    }
    await rm(root, { recursive: true, force: true });
  });

  const launch = async (id, payload = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/tasks/${id}/launch`,
      payload: {
        profile: 'demo',
        route: 'feature',
        title: 'Касса не пробивает чек',
        description: `Обсуждение: ${link(BUGS, 100)}`,
        sourceUrl: 'https://example.test/tasks/42',
        acceptanceCriteria: [],
        ...payload,
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().outcome, 'launched');
    return JSON.parse(await readFile(path.join(root, 'tickets', `t${id}.ticket.json`), 'utf8'));
  };

  return { app, launch };
}

const HEAD = 'Обсуждение в Telegram';

test('переписка по ссылке доезжает в постановку конвейера', async (t) => {
  const { launch } = await fixture(t, {
    messages: [
      msg({ messageId: 99, text: 'у кого касса под рукой?' }),
      msg(),
      msg({ messageId: 101, text: 'воспроизводится на любом чеке', from: { id: 8, name: 'Пётр' } }),
    ],
  });

  const ticket = await launch(4821);

  // Секция дописана в хвост описания — как уточнения человека и комментарии.
  assert.match(ticket.description, new RegExp(HEAD));
  assert.match(ticket.description, new RegExp(SECRET), 'агент не увидит того, ради чего дали ссылку');
  assert.match(ticket.description, /Кокпит · баги/, 'откуда цитаты — часть постановки');
  assert.match(ticket.description, /← ссылка/, 'на какое сообщение показывали пальцем');
  assert.match(ticket.description, /воспроизводится на любом чеке/, 'ветка, а не одно сообщение');
  // Само описание не тронуто: секция ДОПОЛНЯЕТ постановку.
  assert.match(ticket.description, /^Обсуждение: https:\/\/t\.me\//);
  assert.equal(ticket.taskId, '4821');
});

test('ссылку ищем во всей постановке, а не только в описании', async (t) => {
  // Самое частое место ссылки — комментарий в трекере, а не описание задачи.
  const { launch } = await fixture(t, {
    messages: [msg()],
    comments: [{ author: 'Аня', time: '01.08 12:30', text: `подробности тут ${link(BUGS, 100)}`, isSystem: false }],
  });

  const ticket = await launch(4822, { description: 'Касса не пробивает чек.' });
  assert.match(ticket.description, new RegExp(HEAD));
  assert.match(ticket.description, new RegExp(SECRET));
});

test('одна ссылка в описании и в комментарии — один блок', async (t) => {
  const { launch } = await fixture(t, {
    messages: [msg()],
    comments: [{ author: 'Аня', time: '01.08 12:30', text: `дублирую: ${link(BUGS, 100)}`, isSystem: false }],
  });

  const ticket = await launch(4823);
  const blocks = ticket.description.match(/Чат «Кокпит · баги»/g) || [];
  assert.equal(blocks.length, 1, 'одну переписку показали дважды');
});

test('чат чужого проекта в постановку не попадает', async (t) => {
  // Прогон идёт по профилю demo, а чат привязан к alpha: содержимое соседнего
  // проекта не имеет права уехать агенту только потому, что кто-то вписал ссылку.
  const { launch } = await fixture(t, {
    messages: [msg()],
    rules: [{ project: 'alpha', chatId: BUGS }],
  });

  const ticket = await launch(4824);
  assert.equal(ticket.description.includes(SECRET), false, 'переписка чужого проекта уехала в тикет');
  assert.equal(ticket.description.includes('Кокпит · баги'), false, 'даже имя чужого чата уехало в тикет');
  // Причина всё же названа: молчание агент прочитает как «в чате пусто».
  assert.match(ticket.description, /Ссылка не раскрыта/);
  assert.match(ticket.description, /привязан к проекту/i);
});

test('выключенный плагин: постановка ровно такая же, как без телеграма', async (t) => {
  const { launch } = await fixture(t, { enabled: false, messages: [msg()] });

  const ticket = await launch(4825);
  assert.equal(ticket.description.includes(HEAD), false);
  assert.equal(ticket.description.includes('Ссылка не раскрыта'), false, 'выключенный раздел ничего не объясняет');
  assert.equal(ticket.description, `Обсуждение: ${link(BUGS, 100)}`);
});

test('сломанный архив не срывает запуск конвейера', async (t) => {
  const { launch } = await fixture(t, {
    archive: {
      chats: async () => [],
      chatIdOf: async () => { throw new Error('архив недоступен'); },
      branch: async () => { throw new Error('архив недоступен'); },
      append: async () => {},
    },
  });

  const ticket = await launch(4826);
  assert.equal(ticket.description.includes(HEAD), false);
  assert.match(ticket.description, /^Обсуждение: https:\/\/t\.me\//);
});

test('длинная ветка ограничена ДО сборки тикета, а не подрезкой описания', async (t) => {
  // Год переписки в чате: без лимита секция заняла бы всё описание, а
  // `fitDescription` отрезал бы её же с конца — и молча.
  const long = 'а'.repeat(1500);
  const messages = Array.from({ length: 400 }, (_, i) => msg({
    messageId: 50 + i,
    date: T0 + i * 60,
    text: 50 + i === 100 ? SECRET : `${long} #${i}`,
  }));

  const { launch } = await fixture(t, { messages });
  const ticket = await launch(4827);

  assert.match(ticket.description, new RegExp(HEAD));
  assert.match(ticket.description, new RegExp(SECRET), 'целевое сообщение лимитом не срезают');
  assert.equal(ticket.description.includes('[описание обрезано кокпитом'), false, 'секция дошла до подрезки');
  assert.ok(ticket.description.length < 20_000, `описание раздулось до ${ticket.description.length}`);
  // И честно сказано, что показано не всё.
  assert.match(ticket.description, /ещё \d+ сообщени\S* ветки не показан/);
});
