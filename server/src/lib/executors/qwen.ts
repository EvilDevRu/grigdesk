import { promisify } from 'node:util';
import { execFile } from '../providerInstall/externalCliProcess.ts';

import type { ExecutorAdapter } from './index.ts';
import { npmInstallCommand } from '../providerInstall/commands.ts';
import { npmLatest } from './_npmLatest.ts';
import { directSshSetting } from './_directSshPolicy.ts';
import { resolveQwenWorkspace } from '../qwen/workspace.ts';
import { qwenBin, readQwenSnapshot, qwenCredentials, qwenHostEnabled } from '../qwen/settings.ts';
import { projectQwenModels, qwenCatalog, qwenCatalogError } from '../qwen/catalog.ts';
import { openQwenLiveSession, qwenLiveFingerprint } from '../qwen/live.ts';
import { runQwenTurn } from '../qwen/runtime.ts';
import { qwenDiscoveryError } from '../qwen/discovery.ts';

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
   * Наличие ключа не отменяет известный отказ загрузки моделей этого доступа.
   * Карточка читает последний результат каталога, не запуская сеть или OAuth повторно.
   */
  auth(config) {
    const fields = qwenCredentials(config);
    const available = fields.some((field) => field.kind === 'secret' && Boolean(process.env[field.env]));
    const error = available ? qwenDiscoveryError(config) || qwenCatalogError(config) : undefined;

    return {
      mode: 'api-key',
      label: error || (available ? 'Ключ API настроен.' : 'Настройте API-ключ.'),
      available: available && !error,
    };
  },
  credentials: qwenCredentials,
  latestVersion: () => npmLatest('@qwen-code/qwen-code'),
  usage: () => ({
    state: 'unsupported',
    message: 'Получение квот Qwen пока не поддерживается в GrigDesk.',
  }),
  catalogLive: true,
  legacyTextStepDeltas: true,
  inTurnInput: {
    protocol: 1,
    text: true,
    confirmation: 'forwarded',
    images: true,
  },
  catalog: qwenCatalog,
  catalogCacheKey: (config) => `${readQwenSnapshot(config).fingerprint}:native-model-options-v1`,
  /**
   * Смена автоматического сервиса или ключа снимает каталог прежнего доступа.
   * Явный источник CLI сохраняет прежнее поведение при пустом или повреждённом JSON.
   */
  catalogAccessScope: (config) => {
    try {
      const source = readQwenSnapshot(config);

      return source.automatic ? source.fingerprint : 'configured';
    } catch {
      return 'configured';
    }
  },
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
  workdir: { switch: 'reseed', roots: 'multi' },
  /**
   * Дополнительные корни становятся workspace CLI и writable mounts одной песочницы.
   * Общая проверка путей применяется до смены памяти и повторяется при прямом запуске.
   */
  async validateWorkdir({ cwd, extraDirs }) {
    const workspace = await resolveQwenWorkspace(cwd, extraDirs);

    return { extraDirs: workspace.extraDirs };
  },
  directSshPolicy: () => ({ enforcement: 'command-hook', note: 'Проверка перед исполнением инструмента.' }),
  settings: () => [
    directSshSetting(),
    {
      id: 'allowHostAccess',
      kind: 'toggle',
      label: 'Режим «Хост»',
      hint: 'Docker, процессы и файлы пользователя сервера. '
        + 'Нужны живые сессии чата и user systemd приложения.',
      value: false,
      confirm: {
        on: {
          text: 'Qwen получит доступ к Docker, процессам и файлам с правами пользователя сервера. '
            + 'Подтверждения и запрет прямого SSH сохраняются. '
            + 'Изменение применяется к следующему ходу; текущий процесс закрывается отдельно.',
          label: 'Включить режим «Хост»',
          danger: true,
        },
      },
    },
  ],
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
    securityProfile: (_config, providerSettings) => qwenHostEnabled(providerSettings)
      ? 'qwen-host-builtin-guard-v1' : 'qwen-bwrap-private-guard-v1',
  },
  mcpStatus: () => ({ servers: [], note: 'MCP выдаётся сервером для каждого хода.' }),
  compaction: { kind: 'summary' },
  session: {
    mode: 'persistent',
    unsolicited: true,
    keepAlive: true,
    enabled: (spec: Record<string, unknown>) => !spec.factory && qwenHostEnabled(spec.providerSettings),
    fingerprint: qwenLiveFingerprint,
    open: openQwenLiveSession,
  },
  run: runQwenTurn,
};

export default adapter;
