// Инструменты хода Ollama (вспомогательный модуль исполнителя ollama.js).
//
// Демон Ollama сам ничего не исполняет: он лишь возвращает tool_calls в ответе, а
// выполняет их кокпит. Поэтому здесь и набор инструментов, и ПЕСОЧНИЦА путей, и
// политика разрешений — всё, чего у локальной модели нет из коробки, в отличие от
// агентских CLI (claude/codex/kimi приносят это с собой).
//
// Граница доступа: каждый путь резолвится через realpath и обязан лежать внутри cwd
// хода либо одного из доверенных каталогов («Настройки → Исполнители»). realpath здесь
// принципиален — иначе симлинк внутри рабочего дерева выводил бы наружу.
//
// ВАЖНО про bash: у команды границы путей нет — оболочка может дотянуться куда угодно.
// Это осознанно: инструмент нужен для сборки и тестов. Держится он не песочницей, а
// подтверждением человека и fail-closed классификатором деструктивных команд
// (lib/chat/auto-approve.js), тем же, что у Kimi.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { cut, cutMiddle, base, lineCount } from '../chat/stream-steps.js';

// Сколько текста инструмент возвращает МОДЕЛИ. Жёстче, чем лента для человека:
// результат уезжает обратно в контекст, а у локальной модели он 32k по умолчанию —
// пара нестриженых выводов, и разговор упёрся в потолок.
export const RESULT_LIMIT = 4000;
// Предел вызовов за один ход: страховка от зацикливания модели на одном инструменте.
export const MAX_TOOL_CALLS = 40;
// Потолок на чтение файла целиком (строк) — дальше модель просит offset/limit сама.
const READ_LINES = 400;
const BASH_TIMEOUT_MS = 120000;

/** Обрезка того, что уходит в контекст модели, с честной пометкой. */
function trim(text, limit = RESULT_LIMIT) {
  const s = String(text ?? '');
  return s.length > limit ? `${s.slice(0, limit)}\n… вывод обрезан (${s.length} символов)` : s;
}

/**
 * realpath самого глубокого существующего предка + оставшийся хвост. Нужен для записи
 * в ЕЩЁ НЕ созданный файл: realpath на нём падает, а проверить границу надо до создания.
 */
async function realpathDeepest(target) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch { /* нет такого пути — поднимаемся к существующему предку */ }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(target); // дошли до корня ФС
    tail.unshift(path.basename(current));
    current = parent;
  }
}

function inside(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

// ── Каталог инструментов ───────────────────────────────────────────────────────
// ribbon — имя шага для ленты (StepList знает иконки Read/Write/Edit/Bash/Grep/Glob);
// kind — словарь ACP-действий, на котором работает общий классификатор авто-режима;
// write — меняет ли состояние (от этого зависит и режим «только чтение»).
const TOOLS = [
  {
    name: 'read_file',
    ribbon: 'Read',
    kind: 'read',
    write: false,
    schema: {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Прочитать текстовый файл проекта. Путь — абсолютный или относительно рабочего каталога.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Путь к файлу' },
            offset: { type: 'integer', description: 'С какой строки читать (с 1). По умолчанию с начала.' },
            limit: { type: 'integer', description: `Сколько строк прочитать (по умолчанию ${READ_LINES}).` },
          },
          required: ['path'],
        },
      },
    },
    describe: (args) => ({ title: base(args.path), sub: String(args.path || '') }),
    async run(args, { resolvePath }) {
      const file = await resolvePath(args.path);
      const stat = await fs.stat(file);
      if (stat.isDirectory()) return { ok: false, text: 'это каталог, а не файл — используй list_dir' };
      const raw = await fs.readFile(file, 'utf8');
      const lines = raw.split('\n');
      const from = Math.max(0, (Number(args.offset) || 1) - 1);
      const count = Math.max(1, Number(args.limit) || READ_LINES);
      const slice = lines.slice(from, from + count);
      const tailNote = from + count < lines.length
        ? `\n… показаны строки ${from + 1}–${from + slice.length} из ${lines.length}`
        : '';
      return { ok: true, text: trim(slice.join('\n')) + tailNote, lines: slice.length };
    },
  },
  {
    name: 'list_dir',
    ribbon: 'Glob',
    kind: 'read',
    write: false,
    schema: {
      type: 'function',
      function: {
        name: 'list_dir',
        description: 'Показать содержимое каталога (файлы и подкаталоги).',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Путь к каталогу' } },
          required: ['path'],
        },
      },
    },
    describe: (args) => ({ title: base(args.path) || String(args.path || ''), sub: String(args.path || '') }),
    async run(args, { resolvePath }) {
      const dir = await resolvePath(args.path);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const rows = entries
        .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return { ok: true, text: trim(rows.join('\n')) || '(каталог пуст)', lines: rows.length };
    },
  },
  {
    name: 'grep',
    ribbon: 'Grep',
    kind: 'search',
    write: false,
    schema: {
      type: 'function',
      function: {
        name: 'grep',
        description: 'Найти текст в файлах (регулярное выражение), рекурсивно по каталогу.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Что искать (регулярное выражение)' },
            path: { type: 'string', description: 'Где искать: каталог или файл. По умолчанию рабочий каталог.' },
            include: { type: 'string', description: 'Маска имён файлов, например *.js' },
          },
          required: ['pattern'],
        },
      },
    },
    describe: (args) => ({ title: String(args.pattern || ''), sub: String(args.path || '') }),
    async run(args, { resolvePath, cwd, signal }) {
      const where = await resolvePath(args.path || cwd);
      const argv = ['-rIn', '--exclude-dir=.git', '--exclude-dir=node_modules'];
      if (args.include) argv.push(`--include=${String(args.include)}`);
      argv.push('-e', String(args.pattern), where);
      const out = await runProcess('grep', argv, { cwd, signal, allowExitCode: 1 });
      if (out.code === 1) return { ok: true, text: 'ничего не найдено', lines: 0 };
      return { ok: true, text: trim(out.stdout), lines: lineCount(out.stdout) };
    },
  },
  {
    name: 'write_file',
    ribbon: 'Write',
    kind: 'edit',
    write: true,
    schema: {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Создать файл или полностью перезаписать существующий.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Путь к файлу' },
            content: { type: 'string', description: 'Новое содержимое файла целиком' },
          },
          required: ['path', 'content'],
        },
      },
    },
    describe: (args) => ({
      title: base(args.path),
      sub: String(args.path || ''),
      preview: cut(String(args.content ?? '')),
      lines: lineCount(args.content),
    }),
    permissionInput: (args) => ({ file_path: String(args.path || '') }),
    async run(args, { resolvePath }) {
      const file = await resolvePath(args.path);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, String(args.content ?? ''), 'utf8');
      return { ok: true, text: `записано: ${file}` };
    },
  },
  {
    name: 'edit_file',
    ribbon: 'Edit',
    kind: 'edit',
    write: true,
    schema: {
      type: 'function',
      function: {
        name: 'edit_file',
        description: 'Заменить фрагмент в файле. old_string должен встречаться ровно один раз.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Путь к файлу' },
            old_string: { type: 'string', description: 'Что заменить (точное совпадение)' },
            new_string: { type: 'string', description: 'На что заменить' },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
    },
    describe: (args) => ({
      title: base(args.path),
      sub: String(args.path || ''),
      diff: { old: String(args.old_string ?? ''), new: String(args.new_string ?? '') },
    }),
    permissionInput: (args) => ({ file_path: String(args.path || '') }),
    async run(args, { resolvePath }) {
      const file = await resolvePath(args.path);
      const old = String(args.old_string ?? '');
      const next = String(args.new_string ?? '');
      const raw = await fs.readFile(file, 'utf8');
      const hits = old ? raw.split(old).length - 1 : 0;
      if (!hits) return { ok: false, text: 'фрагмент old_string в файле не найден — прочитай файл и повтори точнее' };
      if (hits > 1) return { ok: false, text: `фрагмент встречается ${hits} раз — возьми более длинный кусок с контекстом` };
      await fs.writeFile(file, raw.replace(old, next), 'utf8');
      return { ok: true, text: `правка внесена: ${file}` };
    },
  },
  {
    name: 'bash',
    ribbon: 'Bash',
    kind: 'execute',
    write: true,
    schema: {
      type: 'function',
      function: {
        name: 'bash',
        description: 'Выполнить команду оболочки в рабочем каталоге (сборка, тесты, git).',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Команда для bash -c' },
            description: { type: 'string', description: 'Коротко: зачем эта команда' },
          },
          required: ['command'],
        },
      },
    },
    describe: (args) => ({
      title: cut(String(args.description || args.command || ''), 80),
      command: cutMiddle(String(args.command || '')),
    }),
    permissionInput: (args) => ({
      command: String(args.command || ''),
      description: String(args.description || ''),
    }),
    async run(args, { cwd, signal }) {
      const out = await runProcess('bash', ['-c', String(args.command || '')], {
        cwd, signal, allowExitCode: null, timeoutMs: BASH_TIMEOUT_MS,
      });
      const body = [out.stdout, out.stderr].filter(Boolean).join('\n').trim();
      if (out.code === 0) return { ok: true, text: trim(body) || '(команда отработала, вывода нет)' };
      return { ok: false, text: trim(`код ${out.code}\n${body}`) };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Подпроцесс с общим abort хода. allowExitCode — какой ненулевой код НЕ считать сбоем. */
function runProcess(cmd, argv, { cwd, signal, allowExitCode, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, argv, { cwd, signal, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err?.code;
        if (!err) { resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) }); return; }
        if (signal?.aborted) { reject(err); return; }
        if (allowExitCode === null || code === allowExitCode) {
          resolve({ code: Number.isFinite(code) ? code : 1, stdout: String(stdout || ''), stderr: String(stderr || err.message) });
          return;
        }
        reject(err);
      });
  });
}

/** Декларации инструментов для поля tools запроса /api/chat. */
export function toolDeclarations() {
  return TOOLS.map((t) => t.schema);
}

/**
 * Режимы прав исполнителя. Порядок — от осторожного к свободному, план первым
 * (та же логика, что у claude MODE_LABELS).
 */
export function toolModes() {
  return [
    { id: 'plan', label: 'план', hint: 'только чтение: файлы не меняются, команды не выполняются' },
    { id: 'manual', label: 'спрашивать', hint: 'подтверждение на каждую правку и команду' },
    { id: 'auto', label: 'авто', hint: 'безопасное выполняется само, деструктивное — с подтверждением' },
    { id: 'acceptEdits', label: 'правки молча', hint: 'файлы правятся без вопросов, команды — с подтверждением' },
    { id: 'dontAsk', label: 'без вопросов', hint: 'выполняется всё без подтверждений' },
  ];
}

/**
 * Песочница + политика на один ход.
 * roots — cwd хода и доверенные каталоги; onPermission — тот же мост всплывашки,
 * которым пользуется Kimi (modules/chat). sink — лента шагов.
 */
export async function createToolbox({
  cwd, roots = [], permissionMode = 'manual', onPermission, sink, signal,
} = {}) {
  // Корни резолвим один раз: realpath — дорогой сисколл, а проверять их надо на каждый путь.
  const realRoots = [];
  for (const root of [cwd, ...roots].filter(Boolean)) {
    try { realRoots.push(await fs.realpath(root)); } catch { /* каталога нет — не корень */ }
  }
  let calls = 0;

  async function resolvePath(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('путь не указан');
    const target = await realpathDeepest(path.isAbsolute(raw) ? raw : path.join(cwd || '.', raw));
    if (!realRoots.some((root) => inside(root, target))) {
      throw new Error(`путь вне доступных каталогов: ${raw}. Доступны: ${realRoots.join(', ') || '(нет)'}`);
    }
    return target;
  }

  /**
   * Можно ли выполнить действие. Режимы решаются здесь (о них знает только каталог
   * инструментов: какой вызов пишет, а какой читает), а режим «авто» — на мосту
   * modules/chat общим классификатором: политика одна на всех прямых исполнителей.
   */
  async function authorize(tool, args) {
    if (!tool.write) return { ok: true };
    if (permissionMode === 'plan') {
      return { ok: false, text: `режим «план» — только чтение, ${tool.name} не выполняется. Опиши, что нужно сделать.` };
    }
    if (permissionMode === 'dontAsk' || permissionMode === 'bypassPermissions') return { ok: true };
    if (permissionMode === 'acceptEdits' && tool.kind === 'edit') return { ok: true };
    if (typeof onPermission !== 'function') {
      return { ok: false, text: `нет канала подтверждения — ${tool.name} не выполнен` };
    }
    const answer = await onPermission({
      tool: tool.ribbon,
      input: tool.permissionInput ? tool.permissionInput(args) : { ...args },
      // Пояснение к отказу доезжает до модели результатом инструмента — говорим об
      // этом мосту, чтобы фронт не досылал его вторым сообщением.
      acceptsComment: true,
      raw: { toolCall: { kind: tool.kind, title: String(args.command || args.path || '') } },
    });
    if (answer?.allow) return { ok: true };
    const comment = String(answer?.comment || '').trim();
    return { ok: false, text: `человек отклонил действие${comment ? `: ${comment}` : ''}` };
  }

  /**
   * Выполнить один вызов модели. Ошибки инструмента НЕ роняют ход: они возвращаются
   * модели текстом, чтобы та исправилась сама (кроме отмены хода человеком).
   */
  async function call({ name, args }) {
    const tool = BY_NAME.get(String(name));
    const id = `t${(calls += 1)}`;
    if (!tool) {
      sink?.emit({ k: 'tool', id, name: String(name), title: 'неизвестный инструмент' });
      sink?.emit({ k: 'res', id, ok: false, text: 'нет такого инструмента' });
      return { ok: false, text: `инструмента ${name} не существует. Доступны: ${TOOLS.map((t) => t.name).join(', ')}` };
    }
    const safeArgs = args && typeof args === 'object' ? args : {};
    sink?.emit({ k: 'tool', id, name: tool.ribbon, ...tool.describe(safeArgs) });

    const verdict = await authorize(tool, safeArgs);
    if (!verdict.ok) {
      sink?.emit({ k: 'res', id, ok: false, text: verdict.text });
      return { ok: false, text: verdict.text };
    }
    try {
      const out = await tool.run(safeArgs, { resolvePath, cwd, signal });
      sink?.emit({ k: 'res', id, ok: out.ok !== false, text: cut(out.text) });
      return out;
    } catch (err) {
      if (signal?.aborted) throw err;
      const text = String(err?.message || err).slice(0, RESULT_LIMIT);
      sink?.emit({ k: 'res', id, ok: false, text: cut(text) });
      return { ok: false, text };
    }
  }

  return { call, resolvePath, roots: realRoots, get calls() { return calls; } };
}
