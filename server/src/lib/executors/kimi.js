// Kimi Code подключён по ACP. Два режима запуска (config.kimiLaunchMode):
// host (умолчание) — прямой хост-процесс, parity с claude: host fs/config/credentials;
// contained — server-owned contained ACP profile (bwrap + cgroup + egress allowlist),
// host config/skills/plugins/MCP процесс чата не видит. Откат: COCKPIT_KIMI_LAUNCH_MODE=contained.
// Режимный securityProfile для session bindings вычисляет chat-модуль
// (kimiSecurityProfile), статичное поле ниже — каталожная подпись contained-профиля.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { KIMI_RETRY_CONTRACT } from '../chat/retry-contract.js';
import { kimiSeedModels, KIMI_MODELS, KIMI_SECURITY_PROFILE } from '../kimi/profile.js';
import { runContainedKimi } from '../kimi/runtime.js';
import {
  classifyKimiUsageResponse,
  kimiUsageIsRetryable,
  requestKimiManagedUsage,
} from '../kimi/usage.js';
import { withRetry } from '../retry.js';
import { directSshSetting } from './_direct-ssh-policy.js';

function probe(bin) {
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
// /compact — боевой путь кнопки сжатия; в меню скрыт дедупликацией (кокпит сильнее).
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
function kimiSkillFrontmatter(text) {
  const fm = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!fm) return {};
  const field = (key) => {
    const line = fm[1].split(/\r?\n/).find((l) => new RegExp(`^${key}\\s*:`).test(l));
    return line ? line.replace(new RegExp(`^${key}\\s*:\\s*`), '').replace(/^["']|["']$/g, '').trim() : '';
  };
  return { name: field('name'), description: field('description') };
}

async function scanKimiUserSkills(config) {
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

export default {
  id: 'kimi',
  name: 'Kimi Code',
  vendor: 'Moonshot AI',
  color: '#6657d9',
  order: 3,
  workToolsTransport: 'mcp',
  // Основной официальный способ: отдельный бинарник с проверкой SHA-256, без
  // зависимости от системного Node.js.
  install: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
  login: 'kimi login',
  securityProfile: KIMI_SECURITY_PROFILE,
  retryContract: KIMI_RETRY_CONTRACT,
  compaction: { kind: 'native', message: '/compact' },
  // В host-режиме ACP не умеет принять extraDirs; contained объявляет их через
  // server-owned local.toml и монтирует в sandbox. UI получает фактический режим.
  trustedDirectories(config) { return config.kimiLaunchMode === 'contained'; },
  directSshPolicy(config) {
    if (config?.kimiLaunchMode === 'contained') {
      return {
        enforcement: 'network-sandbox',
        note: 'Contained-режим оставляет SSH закрытым сетевой песочницей при любом значении.',
      };
    }
    return {
      enforcement: 'fail-closed',
      note: 'Host-режим не умеет обеспечить запрет и остановит ход.',
    };
  },
  settings(config) {
    const host = config?.kimiLaunchMode !== 'contained';
    return [directSshSetting({
      note: host
        ? 'Host-режим не умеет обеспечить запрет и остановит ход.'
        : 'Contained-режим закрывает SSH сетевой песочницей независимо от тумблера.',
      extraConfirmation: 'При будущей смене contained на host разрешение останется снятым.',
    })];
  },

  bin(config) { return config.kimiBin; },

  probe(config) { return probe(config.kimiBin); },

  // Проверяем только наличие credential-файла. Его содержимое Cockpit не читает,
  // не копирует и не логирует; самой авторизацией по-прежнему владеет `kimi login`.
  async auth(config) {
    try {
      await fs.access(path.join(config.kimiHome, 'credentials', 'kimi-code.json'));
      return { mode: 'cli', label: 'CLI хоста (kimi login)', available: true };
    } catch {
      return { mode: 'none', label: 'не авторизован (kimi login)', available: false };
    }
  },

  async modes() {
    return [
      { id: 'default', order: 1, label: 'Спрашивать', hint: 'Kimi спрашивает перед изменениями и командами.' },
      // «Авто» — кокпит-политика поверх ACP-режима default: безопасные действия
      // разрешает классификатор (lib/chat/auto-approve.js), деструктивные и
      // неизвестные уходят человеку. На ACP-режим `auto` он намеренно НЕ мапится:
      // там решение принимает сам Kimi, и всплывашка кокпита перестаёт появляться.
      { id: 'auto', order: 2, label: 'Авто', hint: 'Правки и команды без спроса; деструктивные — только с подтверждением.' },
      { id: 'plan', order: 3, label: 'План', hint: 'Сначала составить план и дождаться его подтверждения.' },
      // «Без подтверждений» — родной ACP-режим `yolo` самого Kimi (ACP_MODES бинаря:
      // default | plan | auto | yolo). Кокпит его не имитирует: спросов не будет
      // вовсе, поэтому и классификатор к нему не применяется.
      { id: 'yolo', order: 4, label: 'Без подтверждений', hint: 'Kimi делает всё сам, не спрашивая (родной режим yolo).' },
    ];
  },

  seedModels() { return kimiSeedModels(); },

  async commands(config) {
    const skills = await scanKimiUserSkills(config);
    const builtin = new Set(KIMI_ACP_COMMANDS.map((c) => c.cmd));
    return [...KIMI_ACP_COMMANDS, ...skills.filter((s) => !builtin.has(s.cmd))];
  },

  // Каталог version-pinned: live provider list может содержать пользовательские API
  // keys, поэтому runtime и реестр его автоматически не вызывают.
  catalog() { return kimiSeedModels(); },

  modelFamily(model) {
    return KIMI_MODELS.find((candidate) => candidate.id === model?.id)?.wireModel
      || String(model?.family || '');
  },

  /**
   * Официальный read-only `/api/v1/oauth/usage` через краткоживущий loopback
   * server самого Kimi. Cockpit не открывает OAuth credential file и не создаёт
   * model session/turn.
   */
  async usage(config, deps = {}) {
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

  run(options) { return runContainedKimi(options); },

  // updateCmd и latestVersion намеренно отсутствуют: версия запинена в contract gate
  // (runtime.js REQUIRED_KIMI_VERSION), самовольное обновление сломает запуск. Новая
  // версия допускается только через повторный ACP contract gate и security matrix.
};
