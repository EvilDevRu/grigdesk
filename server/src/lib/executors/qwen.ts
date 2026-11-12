import { promisify } from 'node:util';
import { execFile } from '../providerInstall/externalCliProcess.ts';

import type { ExecutorAdapter } from './index.ts';
import { npmInstallCommand } from '../providerInstall/commands.ts';
import { npmLatest } from './_npmLatest.ts';
import { directSshSetting } from './_directSshPolicy.ts';
import { validateWorkdirPath } from '../chat/workdir.ts';
import { qwenBin, readQwenSnapshot, qwenCredentials } from '../qwen/settings.ts';
import { projectQwenModels, qwenCatalog } from '../qwen/catalog.ts';
import { runQwenTurn } from '../qwen/runtime.ts';

const execute = promisify(execFile);
const binding = {
  binName: 'qwen',
  configKey: 'qwenBin',
  envKey: 'GRIGDESK_QWEN_BIN',
};

const adapter: ExecutorAdapter = {
  id: 'qwen',
  name: 'Qwen Code',
  vendor: 'Alibaba Cloud',
  type: 'universal',
  color: '#6153d9',
  order: 6,
  bin: qwenBin,
  externalCli: () => ({ packageId: '@qwen-code/qwen-code', ...binding }),
  installation: (_config, context) => {
    const install = npmInstallCommand('@qwen-code/qwen-code', context?.npm || 'npm', binding);

    return {
      install,
      update: { ...install },
      loginCommand: '',
    };
  },
  /**
   * Версия проверяется у выбранного CLI тем же launcher-ом, что держит reader lease.
   * Ошибка установки не раскрывает окружение и не превращается в готовность карточки.
   */
  async probe(config) {
    try {
      const { stdout } = await execute(qwenBin(config), ['--version'], { timeout: 10000 });

      return { ok: true, version: stdout.trim().slice(0, 60) || null };
    } catch {
      return { ok: false, version: null };
    }
  },
  /**
   * Наличие ключа — локальная готовность, а не обещание оплаченной квоты.
   * Сеть и OAuth карточка не запускает; реальный отказ API возвращается ходом.
   */
  auth(config) {
    const fields = qwenCredentials(config);
    const available = fields.some((field) => Boolean(process.env[field.env]));

    return {
      mode: 'api-key',
      label: available ? 'Ключ API настроен.' : 'Настройте API-ключ.',
      available,
    };
  },
  credentials: qwenCredentials,
  latestVersion: () => npmLatest('@qwen-code/qwen-code'),
  catalogLive: true,
  catalog: qwenCatalog,
  catalogCacheKey: (config) => readQwenSnapshot(config).fingerprint,
  /**
   * Начальный список использует только существующий локальный источник.
   * Повреждённый или пустой конфиг не заменяется выдуманными моделями.
   */
  seedModels() {
    try {
      return projectQwenModels(readQwenSnapshot({}));
    } catch {
      return [];
    }
  },
  workToolsTransport: 'mcp',
  workdir: { switch: 'reseed', roots: 'single' },
  /**
   * Дополнительная writable папка не обещается поверх одно-корневой песочницы.
   * Основной путь проходит общую физическую проверку до любого запуска.
   */
  async validateWorkdir({ cwd, extraDirs }) {
    await validateWorkdirPath(cwd);

    return extraDirs.length
      ? { extraDirs: [], error: 'Qwen: поддерживается одна рабочая папка' }
      : { extraDirs: [] };
  },
  directSshPolicy: () => ({ enforcement: 'command-hook', note: 'Проверка перед исполнением инструмента.' }),
  settings: () => [directSshSetting()],
  modes: () => [
    {
      id: 'default',
      label: 'Спрашивать',
      order: 1,
    },
    {
      id: 'auto',
      label: 'Авто',
      order: 2,
    },
    {
      id: 'plan',
      label: 'План',
      order: 3,
    },
    {
      id: 'yolo',
      label: 'Без подтверждений',
      order: 4,
    },
  ],
  sessionBinding: {
    authProfileId: (config) => readQwenSnapshot(config).fingerprint,
    securityProfile: () => 'qwen-bwrap-private-guard-v1',
  },
  mcpStatus: () => ({ servers: [], note: 'MCP выдаётся сервером для каждого хода.' }),
  compaction: { kind: 'summary' },
  run: runQwenTurn,
};

export default adapter;
