import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { chatAppFixture, controlledExecutor, TEST_MODEL_REF } from './chat-turns.js';
import { ChatTurnLedger } from '../../../server/src/lib/chat/turnLedger.ts';
import { ChatInTurnLedger } from '../../../server/src/lib/chat/inTurnLedger.ts';

export const CHAT_AT = Date.UTC(2026, 8, 1);

/**
 * Создаёт прежний файловый формат истории до запуска модуля.
 * Вся история принадлежит временной папке фикстуры, не профилю владельца.
 */
export async function listFixture(t, chats = [], options = {}) {

  const root = options.root || await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-list-'));

  const config = { chatsDir: path.join(root, 'chats') };

  for (const chat of chats) {
    await writeChat({ config }, chat);
  }

  if (options.legacy) {
    await fs.writeFile(path.join(root, 'legacy.json'), JSON.stringify(options.legacy));
  }

  const turns = new ChatTurnLedger({ dir: path.join(config.chatsDir, 'turns') });

  const inTurn = new ChatInTurnLedger({ dir: path.join(config.chatsDir, 'in-turn') });

  for (const entry of options.turns || []) {
    await turns.put(entry);
  }
  for (const entry of options.inTurn || []) {
    await inTurn.put(entry);
  }

  const fixture = await chatAppFixture(t, {
    executor: controlledExecutor().executor,
    ...options,
    root,
  });

  await fixture.app.ready();
  t.after(async () => {
    await fixture.app.close();
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
    });
  });

  return fixture;
}

/**
 * Задаёт полный сохранённый чат в прежнем формате.
 * Все изменения сценария передаются явно поверх общей модели фикстуры.
 */
export function sampleChat(id = 'catalog-one', extra = {}) {
  return {
    id,
    title: 'Разговор',
    model: TEST_MODEL_REF.model,
    modelRef: TEST_MODEL_REF,
    createdAt: CHAT_AT,
    updatedAt: CHAT_AT,
    revision: 3,
    messages: [{
      role: 'assistant',
      text: 'Ответ',
      steps: [{
      k: 'text',
      text: 'Скрытый шаг',
    }],
    }],
    ...extra,
  };
}

/**
 * Выбирает месяц по createdAt так же, как файловое хранилище.
 * Проверки читают тот же файл, который обрабатывает сервер.
 */
export function chatPath(fixture, chat) {

  const month = new Date(chat.createdAt).toISOString().slice(0, 7);

  return path.join(fixture.config.chatsDir, month, `${chat.id}.json`);
}

/**
 * Записывает синтетический JSON в каталог отдельной фикстуры.
 * Это также имитирует внешнюю правку без изменения updatedAt.
 */
export async function writeChat(fixture, chat) {

  const file = chatPath(fixture, chat);

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(chat));
}

/**
 * Читает итог именно с диска после серверного действия.
 * Ответ API не заменяет доказательство сохранности истории.
 */
export async function readChat(fixture, chat) {
  return JSON.parse(await fs.readFile(chatPath(fixture, chat), 'utf8'));
}

/**
 * Проверяет HTTP-успех перед разбором результата.
 * Отсутствующий маршрут остаётся явным RED с адресом и статусом.
 */
export async function jsonRequest(app, method, url, payload) {

  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
  });

  assert.equal(response.statusCode, 200, `${method} ${url}: ${response.body}`);

  return response.json();
}

/**
 * Объединяет обе группы каталога только для проверки состава.
 * Отдельные проверки сохраняют различие активного списка и архива.
 */
export function headsOf(data) {
  return [...data.sessions, ...data.archived];
}

/**
 * Строит known из реально выданных непрозрачных версий.
 * Временные отметки не подменяют серверную версию файла.
 */
export function versionsOf(data) {
  return Object.fromEntries(headsOf(data).map((head) => [head.id, head.version]));
}

/**
 * Контроль лёгкого ответа проверяет вложенные объекты, а не только корень.
 * Служебные краткие поля допустимы, тела истории и вложений запрещены.
 */
export function assertLight(value) {
  if (!value || typeof value !== 'object') {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    assert.equal(['messages', 'steps', 'draftAttachments', 'outbox'].includes(key), false, key);
    assertLight(child);
  }
}

/**
 * Кладёт полный результат в прежнюю папку pending фикстуры.
 * Удаление файла проверяется отдельно от ответа маршрута.
 */
export async function putPending(fixture, entry) {

  const dir = path.join(fixture.config.chatsDir, 'pending');

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${entry.id}.json`), JSON.stringify(entry));
}

/**
 * Запрашивает сверку голов без загруженных лент по умолчанию.
 * Идентификаторы полных чатов и доставки задаются отдельными параметрами.
 */
export async function reconcile(app, extra = {}) {
  return jsonRequest(app, 'POST', '/api/chat/store/reconcile', {
    loadedIds: [],
    deliveryIds: [],
    ...extra,
  });
}
