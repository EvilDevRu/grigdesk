// Kimi Code подключён по ACP. Два режима запуска (config.kimiLaunchMode):
// host (умолчание) — прямой хост-процесс, parity с claude: host fs/config/credentials;
// contained — server-owned contained ACP profile (bwrap + cgroup + egress allowlist),
// host config/skills/plugins/MCP процесс чата не видит. Откат: GRIGDESK_KIMI_LAUNCH_MODE=contained.
// Режимный securityProfile для session bindings вычисляет chat-модуль
// (kimiSecurityProfile), статичное поле ниже — каталожная подпись contained-профиля.
import { execFile } from '../providerInstall/externalCliProcess.ts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { npmLatest } from './_npmLatest.ts';
import type { ProviderInstallationContext } from './index.ts';
import { npmInstallCommand } from '../providerInstall/commands.ts';

import { validateKimiWorkdir } from '../kimi/sandbox.ts';
import type { KimiSandboxConfig } from '../kimi/sandbox.ts';
import { findKimiCredentialFile } from '../kimi/credentials.ts';

import { KIMI_RETRY_CONTRACT } from '../chat/retryContract.ts';
import {
  kimiSeedModels,
  KIMI_AUTH_PROFILE_ID,
  KIMI_MODELS,
  KIMI_SECURITY_PROFILE,
  kimiSecurityProfile,
} from '../kimi/profile.ts';
import { runContainedKimi } from '../kimi/runtime.ts';
import {
  classifyKimiUsageResponse,
  kimiUsageIsRetryable,
  requestKimiManagedUsage,
} from '../kimi/usage.ts';
import { withRetry } from '../retry.ts';
import { directSshSetting } from './_directSshPolicy.ts';
import { kimiNativeSettings } from '../executorSettings/kimi.ts';

// Серверный config в объёме, который читает адаптер. Полная его форма объявлена
// в config.ts; здесь перечислено ровно то, что нужно запуску и опросам Kimi.
// Алиас, а не interface: у алиаса есть неявная индексная подпись, и config уходит
// в общие помощники (`requestKimiManagedUsage`), которые читают его как словарь.
type KimiConfig = {
  kimiBin: string;
  kimiHome: string;
  kimiRuntimeHome?: string;
  kimiLaunchMode?: string;
  rootDir?: string;
};

// Слой mcp.json: чей файл прочитан и что в нём лежит. Содержимое недоверенное,
// поэтому форма записей проверяется на месте, а не объявляется здесь.
interface KimiMcpLayer {
  scope: 'user' | 'project';
  config: { mcpServers?: unknown } | null;
}

// Результат чтения одного mcp.json. `ok: false` — файл есть, но он не по схеме;
// `value: null` — файла нет вовсе, и это не ошибка.
interface KimiMcpRead {
  ok: boolean;
  value?: { mcpServers?: unknown } | null;
}

// Запись сервера MCP для карточки настроек: цель уже обеззаражена от credential.
interface KimiMcpServerCard {
  name: string;
  target: string;
  scope: 'user' | 'project';
  state: string;
  detail: string;
}

function probe(bin: string) {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, version: null });
      resolve({ ok: true, version: (stdout || '').trim().slice(0, 60) || null });
    });
  });
}

// Локальные ACP-команды Kimi: исполняются сервером ACP без вызова модели и отвечают
// текстом в ленту. Состав зафиксирован contract gate против pinned 0.31.1:
// TUI-команды (/new, /clear, /model, /goal…)
// ACP не знает — отвечает «Unknown ACP command», в список их брать нельзя. При смене
// pinned-версии список пересматривается вместе с contract gate.
// /compact — боевой путь кнопки сжатия; в меню скрыт дедупликацией (GrigDesk сильнее).
const KIMI_ACP_COMMANDS = [
  { cmd: '/status', desc: 'Состояние сессии: модель, режим, контекст', run: 'prompt' },
  { cmd: '/usage', desc: 'Расход контекста и токенов сессии', run: 'prompt' },
  { cmd: '/tasks', desc: 'Фоновые задачи этой сессии', run: 'prompt' },
  { cmd: '/mcp', desc: 'Состояние MCP-серверов сессии', run: 'prompt' },
  { cmd: '/help', desc: 'Список ACP-команд Kimi', run: 'prompt' },
  { cmd: '/compact', desc: 'Сжать контекст разговора', run: 'prompt' },
];

// Пользовательские скиллы (<активный home>/skills/<имя>/SKILL.md) ACP исполняет как
// слэш-команды /<имя>: /help их не перечисляет, но вызов работает и уходит модели
// (проверено contract gate на pinned 0.31.1). Сканируем home АКТИВНОГО режима: host — kimiHome,
// contained — kimiRuntimeHome (хостовых скиллов contained-профиль не видит). Проектный
// уровень (<cwd>/.kimi-code/skills) не сканируем: глобальный кэш /api/providers не
// знает cwd конкретного чата. Имя — из frontmatter `name`, иначе имя каталога;
// описание — frontmatter `description`, обрезанное до 120 (контракт меню).
function kimiSkillFrontmatter(text: unknown): { name?: string; description?: string } {
  const fm = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!fm) return {};
  const body = fm[1] || '';
  const field = (key: string) => {
    const line = body.split(/\r?\n/).find((l) => new RegExp(`^${key}\\s*:`).test(l));
    return line ? line.replace(new RegExp(`^${key}\\s*:\\s*`), '').replace(/^["']|["']$/g, '').trim() : '';
  };
  return { name: field('name'), description: field('description') };
}

async function scanKimiUserSkills(config: KimiConfig) {
  const home = config?.kimiLaunchMode === 'contained' ? config?.kimiRuntimeHome : config?.kimiHome;
  if (!home) return [];
  const dir = path.join(home, 'skills');
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const text = await fs.readFile(path.join(dir, entry.name, 'SKILL.md'), 'utf8');
      const { name, description } = kimiSkillFrontmatter(text);
      const skillName = name || entry.name;
      if (!/^[\w][\w.-]*$/.test(skillName)) continue;
      skills.push({
        cmd: `/${skillName}`,
        desc: (description || 'Пользовательский скилл').slice(0, 120),
        run: 'prompt',
      });
    } catch { /* нет SKILL.md или не читается — пропускаем */ }
  }
  return skills;
}

/** URL показываем без query/fragment/userinfo: там часто лежит credential. */
function safeKimiMcpUrl(value: unknown) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return text.replace(/[?#].*$/, '').slice(0, 240);
  }
}

/** Аргументы оставляем различимыми, но скрываем значения credential-подобных флагов. */
function safeKimiMcpCommand(command: unknown, args: unknown) {
  const parts = [String(command || '').trim()].filter(Boolean);
  const secretFlag = /(?:api[-_]?key|token|secret|password|authorization|header|env)/i;
  let hideNext = false;

  for (const raw of Array.isArray(args) ? args.slice(0, 12) : []) {
    const arg = String(raw);
    if (hideNext) {
      parts.push('•••');
      hideNext = false;
      continue;
    }
    const equal = arg.indexOf('=');
    const key = equal >= 0 ? arg.slice(0, equal) : arg;
    if (secretFlag.test(key)) {
      parts.push(equal >= 0 ? `${key}=•••` : arg);
      hideNext = equal < 0;
      continue;
    }
    parts.push(arg);
  }

  const target = parts.join(' ');
  return `${target.slice(0, 240)}${target.length > 240 ? '…' : ''}`;
}

function kimiMcpServer(name: string, value: unknown, scope: 'user' | 'project'): KimiMcpServerCard {
  const entry = value as { command?: unknown; url?: unknown; args?: unknown; enabled?: unknown };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      name,
      target: '',
      scope,
      state: 'unknown',
      detail: 'Некорректная запись в mcp.json.',
    };
  }

  const command = typeof entry.command === 'string' ? entry.command.trim() : '';
  const url = typeof entry.url === 'string' ? entry.url.trim() : '';
  const target = command
    ? safeKimiMcpCommand(command, entry.args)
    : safeKimiMcpUrl(url);
  if (!target) {
    return {
      name,
      target: '',
      scope,
      state: 'unknown',
      detail: 'В записи mcp.json нет команды или URL.',
    };
  }

  const disabled = entry.enabled === false;
  return {
    name,
    target,
    scope,
    state: disabled ? 'disabled' : 'configured',
    detail: disabled ? 'Сервер выключен в mcp.json.' : '',
  };
}

/**
 * Kimi объединяет user/project mcp.json, причём более близкий проектный слой
 * перекрывает одноимённую запись. Здесь та же effective-семантика, без запуска MCP.
 */
export function composeKimiMcpServers({
  userConfig = null,
  projectConfigs = [],
}: {
  userConfig?: { mcpServers?: unknown } | null;
  projectConfigs?: ReadonlyArray<{ mcpServers?: unknown } | null | undefined>;
} = {}): KimiMcpServerCard[] {
  const layers: KimiMcpLayer[] = [
    { scope: 'user', config: userConfig },
    ...(Array.isArray(projectConfigs)
      ? projectConfigs.map((config): KimiMcpLayer => ({ scope: 'project', config: config || null }))
      : []),
  ];
  const merged = new Map<string, KimiMcpServerCard>();

  for (const layer of layers) {
    const entries = layer.config?.mcpServers;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    for (const [rawName, entry] of Object.entries(entries)) {
      const name = String(rawName || '').trim();
      if (!name || name === 'grigdesk-work') continue;
      merged.set(name, kimiMcpServer(name, entry, layer.scope));
    }
  }

  const scopeOrder: Record<'user' | 'project', number> = { user: 0, project: 1 };
  return [...merged.values()].sort((left, right) => (
    scopeOrder[left.scope] - scopeOrder[right.scope]
    || left.name.localeCompare(right.name, 'ru')
  ));
}

async function readKimiMcpFile(file: string): Promise<KimiMcpRead> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') return { ok: true, value: null };
    return { ok: false };
  }

  const object = Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const entries = (value as { mcpServers?: unknown } | null)?.mcpServers;
  const validEntries = entries === undefined
    || (entries && typeof entries === 'object' && !Array.isArray(entries));
  return object && validEntries
    ? { ok: true, value: value as { mcpServers?: unknown } }
    : { ok: false };
}

/** Kimi 0.31.x ищет legacy `.mcp.json` у ближайшего корня репозитория. */
async function nearestKimiProjectRoot(cwd?: string): Promise<string | null> {
  let current = path.resolve(cwd || process.cwd());
  while (true) {
    try {
      await fs.access(path.join(current, '.git'));
      return current;
    } catch { /* поднимаемся к родителю */ }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export default {
  id: 'kimi',
  effortHints: {
    low: 'Короткое рассуждение для простых задач; быстрее и экономнее.',
    high: 'Глубокое рассуждение для сложного кода, отладки и анализа.',
    max: 'Максимальное усилие рассуждения для самых трудных задач.',
  },
  nativeSettings: kimiNativeSettings,
  name: 'Kimi Code',
  vendor: 'Moonshot AI',
  color: '#6657d9',
  order: 3,
  workToolsTransport: 'mcp',
  scopedWorkspace: () => process.platform === 'linux',
  sessionBinding: {
    authProfileId: () => KIMI_AUTH_PROFILE_ID,
    securityProfile: (config: KimiConfig) => kimiSecurityProfile(config),
  },
  // Основной официальный способ: отдельный бинарник с проверкой SHA-256, без
  // зависимости от системного Node.js.
  install: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
  usagePresentation: { freshness: true, spentLabel: true },
  /**
   * Host CLI имеет обычную npm/native identity; contained runtime обслуживается отдельно.
   * Корни относятся только к программе и не разрешают удаление KIMI_CODE_HOME целиком.
   */
  externalCli(config: KimiConfig, home: string) {
    if (config.kimiLaunchMode === 'contained') {
      return null;
    }

    const root = path.join(home, '.kimi-code/bin');

    return {
      packageId: '@moonshot-ai/kimi-code',
      binName: 'kimi',
      configKey: 'kimiBin',
      envKey: 'GRIGDESK_KIMI_BIN',
      native: [{ entry: path.join(root, 'kimi'), root }],
    };
  },
  /**
   * Пользовательский npm имеет приоритет перед прежним официальным installer.
   * Contained закрепляет runtime и не допускает обновления через карточку.
   */
  installation(config: KimiConfig, context?: ProviderInstallationContext) {
    const command = 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash';
    const install = context?.npm ? npmInstallCommand('@moonshot-ai/kimi-code', context.npm, {
      binName: 'kimi',
      configKey: 'kimiBin',
      envKey: 'GRIGDESK_KIMI_BIN',
    }) : {
      executable: '/bin/bash',
      args: ['-o', 'pipefail', '-c', command],
      command,
      fallbackCommand: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
    };

    return {
      install,
      update: config.kimiLaunchMode === 'contained' ? null : { ...install },
      loginCommand: 'kimi login',
      loginArgs: ['login'],
      nativeBinDirs: [path.join(os.homedir(), '.local', 'bin')],
    };
  },

  login: 'kimi login',
  // У kimi.com своей страницы состояния нет — сбои публикует Moonshot AI.
  statusPage: 'https://status.moonshot.cn',
  securityProfile: KIMI_SECURITY_PROFILE,
  retryContract: KIMI_RETRY_CONTRACT,
  inTurnInput: {
    protocol: 1,
    text: true,
    confirmation: 'forwarded',
  },
  compaction: { kind: 'native', message: '/compact' },
  // Host-режим не принимает extraDirs; contained объявляет их через server-owned
  // local.toml и монтирует в sandbox. UI получает фактический режим.
  workdir(config: KimiConfig) {
    return { switch: 'reseed', roots: config.kimiLaunchMode === 'host' ? 'single' : 'multi' };
  },
  validateWorkdir({ config, cwd, extraDirs }: {
    config: unknown;
    cwd: string;
    extraDirs: string[];
  }) {
    return (config as KimiConfig).kimiLaunchMode === 'host'
      ? { extraDirs }
      : validateKimiWorkdir({
        config: config as KimiSandboxConfig,
        cwd,
        extraDirs
      });
  },
  directSshPolicy(config: KimiConfig) {
    if (config?.kimiLaunchMode === 'contained') {
      return {
        enforcement: 'network-sandbox',
        note: 'Contained-режим оставляет SSH закрытым сетевой песочницей при любом значении.',
      };
    }

    return {
      enforcement: 'command-broker',
      note: 'Host-режим проверяет команды перед запуском; сбой проверки оставляет команду запрещённой.',
    };
  },
  settings(config: KimiConfig) {
    const host = config?.kimiLaunchMode !== 'contained';

    return [directSshSetting({
      note: host
        ? 'Host-режим проверяет команды перед запуском; сбой проверки оставляет команду запрещённой.'
        : 'Contained-режим закрывает SSH сетевой песочницей независимо от тумблера.',
      extraConfirmation: 'При будущей смене contained на host разрешение останется снятым.',
    })];
  },

  bin(config: KimiConfig) { return config.kimiBin; },

  probe(config: KimiConfig) { return probe(config.kimiBin); },

  // Проверяем только наличие credential-файла: официального kimi-code.json либо
  // scoped kimi-code-env-<hash>.json от входа через кастомное OAuth-окружение.
  // Содержимое GrigDesk не читает, не копирует и не логирует; самой авторизацией
  // по-прежнему владеет `kimi login`.
  async auth(config: KimiConfig) {
    const credential = await findKimiCredentialFile(path.join(config.kimiHome, 'credentials'));

    if (credential) {
      return { mode: 'cli', label: 'CLI хоста (kimi login)', available: true };
    }

    return { mode: 'none', label: 'не авторизован (kimi login)', available: false };
  },

  /**
   * Публичный ACP Kimi не умеет перечислить MCP без создания сессии. Сессия же
   * запустит все stdio-серверы, поэтому Settings безопасно читает effective mcp.json
   * и честно помечает записи как «Настроен», а не «Подключён».
   */
  async mcpStatus(config: KimiConfig, deps: {
    projectRoot?: (cwd?: string) => Promise<string | null>;
    readFile?: (file: string) => Promise<KimiMcpRead>;
  } = {}) {
    if (config?.kimiLaunchMode === 'contained') {
      return {
        state: 'ok',
        note: 'Contained-режим изолирует пользовательские и проектные MCP-серверы.',
        servers: [],
      };
    }

    const cwd = config?.rootDir || process.cwd();
    const projectRoot = await (deps.projectRoot || nearestKimiProjectRoot)(cwd);
    const files = [
      path.join(config.kimiHome, 'mcp.json'),
      ...(projectRoot ? [path.join(projectRoot, '.mcp.json')] : []),
      path.join(cwd, '.kimi-code', 'mcp.json'),
    ];
    const readFile = deps.readFile || readKimiMcpFile;
    const layers = await Promise.all(files.map((file) => readFile(file)));
    if (layers.some((layer: KimiMcpRead) => !layer?.ok)) {
      return {
        state: 'error',
        error: 'Один из файлов Kimi mcp.json содержит некорректный JSON или схему.',
        servers: [],
      };
    }

    return {
      state: 'ok',
      note: 'Показана конфигурация mcp.json; живость Kimi проверяет в новой сессии.',
      servers: composeKimiMcpServers({
        userConfig: layers[0]?.value,
        projectConfigs: layers.slice(1).map((layer: KimiMcpRead) => layer.value),
      }),
    };
  },

  async modes() {
    return [
      { id: 'default', order: 1, label: 'Спрашивать', hint: 'Kimi спрашивает перед изменениями и командами.' },
      // «Авто» — политика GrigDesk поверх ACP-режима default: безопасные действия
      // разрешает классификатор (lib/chat/auto-approve.js), деструктивные и
      // неизвестные уходят человеку. На ACP-режим `auto` он намеренно НЕ мапится:
      // там решение принимает сам Kimi, и всплывашка GrigDesk перестаёт появляться.
      { id: 'auto', order: 2, label: 'Авто', hint: 'Правки и команды без спроса; деструктивные — только с подтверждением.' },
      { id: 'plan', order: 3, label: 'План', hint: 'Сначала составить план и дождаться его подтверждения.' },
      // «Без подтверждений» — родной ACP-режим `yolo` самого Kimi (ACP_MODES бинаря:
      // default | plan | auto | yolo). GrigDesk его не имитирует: спросов не будет
      // вовсе, поэтому и классификатор к нему не применяется.
      { id: 'yolo', order: 4, label: 'Без подтверждений', hint: 'Kimi делает всё сам, не спрашивая (родной режим yolo).' },
    ];
  },

  seedModels() { return kimiSeedModels(); },

  async commands(config: KimiConfig) {
    const skills = await scanKimiUserSkills(config);
    const builtin = new Set(KIMI_ACP_COMMANDS.map((c) => c.cmd));
    return [...KIMI_ACP_COMMANDS, ...skills.filter((s) => !builtin.has(s.cmd))];
  },

  // Каталог version-pinned: live provider list может содержать пользовательские API
  // keys, поэтому runtime и реестр его автоматически не вызывают.
  catalog() { return kimiSeedModels(); },

  modelFamily(model: { id?: unknown; family?: unknown } | null | undefined) {
    return KIMI_MODELS.find((candidate) => candidate.id === model?.id)?.wireModel
      || String(model?.family || '');
  },

  /**
   * Официальный read-only `/api/v1/oauth/usage` через краткоживущий loopback
   * server самого Kimi. GrigDesk не открывает OAuth credential file и не создаёт
   * model session/turn.
   */
  async usage(config: KimiConfig, deps: { sleep?: (ms: number) => Promise<void> } = {}) {
    // Две попытки, а не три: каждая заново поднимает локальный брокер, и запрос из шапки
    // не имеет права висеть дольше своего минутного кэша. Что именно повторяем — решает
    // за это отвечает `kimiUsageIsRetryable`.
    const outcome = await withRetry(() => requestKimiManagedUsage(config), {
      attempts: 2,
      retryWhen: kimiUsageIsRetryable,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    return classifyKimiUsageResponse(outcome);
  },

  run(options: Parameters<typeof runContainedKimi>[0]) {
    return runContainedKimi({ ...options, transport: 'server' });
  },

  /**
   * Native release использует версию официального npm-пакета.
   * В contained закреплённый runtime не предлагает host-обновление.
   */
  latestVersion(config: KimiConfig) {
    return config.kimiLaunchMode === 'contained' ? null : npmLatest('@moonshot-ai/kimi-code');
  },
};
