// Kimi Code подключён через contained ACP runtime. Host CLI используется только как
// version-pinned бинарник и источник managed OAuth; host config/skills/plugins/MCP
// процесс чата не видит.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { KIMI_RETRY_CONTRACT } from '../chat/retry-contract.js';
import { kimiSeedModels, KIMI_MODELS, KIMI_SECURITY_PROFILE } from '../kimi/profile.js';
import { runContainedKimi } from '../kimi/runtime.js';
import { classifyKimiUsageResponse, requestKimiManagedUsage } from '../kimi/usage.js';

function probe(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, version: null });
      resolve({ ok: true, version: (stdout || '').trim().slice(0, 60) || null });
    });
  });
}

export default {
  id: 'kimi',
  name: 'Kimi Code',
  vendor: 'Moonshot AI',
  color: '#6657d9',
  order: 3,
  // Основной официальный способ: отдельный бинарник с проверкой SHA-256, без
  // зависимости от системного Node.js.
  install: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
  login: 'kimi login',
  securityProfile: KIMI_SECURITY_PROFILE,
  retryContract: KIMI_RETRY_CONTRACT,
  compaction: { kind: 'native', message: '/compact' },

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
      // неизвестные уходят человеку. ACP-режимы auto/yolo по-прежнему заблокированы.
      { id: 'auto', order: 2, label: 'Авто', hint: 'Правки и команды без спроса; деструктивные — только с подтверждением.' },
      { id: 'plan', order: 3, label: 'План', hint: 'Сначала составить план и дождаться его подтверждения.' },
    ];
  },

  seedModels() { return kimiSeedModels(); },

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
  async usage(config) {
    return classifyKimiUsageResponse(await requestKimiManagedUsage(config));
  },

  run(options) { return runContainedKimi(options); },

  // updateCmd и latestVersion намеренно отсутствуют: версия запинена в contract gate
  // (runtime.js REQUIRED_KIMI_VERSION), самовольное обновление сломает запуск. Новая
  // версия допускается только через повторный ACP contract gate и security matrix.
};
