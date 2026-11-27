import type { ExecutorAdapter } from './index.ts';
import { directSshSetting } from './_directSshPolicy.ts';
import { resolveQwenWorkspace } from '../qwen/workspace.ts';
import { qwenBin, qwenConfig, readQwenSnapshot, qwenCredentials, qwenHostEnabled } from '../qwen/settings.ts';
import { projectQwenModels, qwenCatalog, qwenCatalogError } from '../qwen/catalog.ts';
import { openQwenLiveSession, qwenLiveFingerprint } from '../qwen/live.ts';
import { runQwenTurn } from '../qwen/runtime.ts';
import { qwenDiscoveryError } from '../qwen/discovery.ts';
import { readUserSkillCommands } from '../skills/userSkillCommands.ts';
import { installQwenPreview } from '../qwen/installPreview.ts';
import {
  qwenPreviewBinary, QWEN_PREVIEW_SUPPORTED, QWEN_PREVIEW_VERSION, verifyQwenPreviewBinary,
} from '../qwen/previewRelease.ts';

/**
 * Кнопка установки пишет только в штатный каталог данных GrigDesk. Переданный
 * конкретным запуском путь используется для проверки, без права его заменить.
 */
function installTarget(config: unknown): string | undefined {
  const root = qwenConfig(config).dataHome;
  const target = root && qwenPreviewBinary(root);

  return QWEN_PREVIEW_SUPPORTED && target === qwenBin(config) ? target : undefined;
}

const adapter: ExecutorAdapter = {
  id: 'qwen',
  name: 'Qwen Code',
  vendor: 'Alibaba Cloud',
  type: 'universal',
  color: '#6153d9',
  order: 6,
  bin: qwenBin,
  distribution: (config, probe) => ({
    managed: true,
    kind: 'binary',
    label: 'Qwen Code 1.0 Preview.2',
    canInstall: Boolean(installTarget(config)),
    ...(probe?.ok ? { runtimeVersion: QWEN_PREVIEW_VERSION } : {}),
    ...(probe && !probe.ok ? {
      problem: { message: QWEN_PREVIEW_SUPPORTED
        ? 'Для чата требуется проверенный Qwen Code 1.0 Preview.2.'
        : 'Qwen Code 1.0 Preview.2 в GrigDesk доступен на Linux x64.' },
    } : {}),
  }),
  async installDistribution(config, signal) {
    const target = installTarget(config);

    if (!target) {
      throw new Error('Установка Qwen Code Preview.2 недоступна в этой конфигурации.');
    }

    await installQwenPreview(target, signal);
  },
  /**
   * Только проверенная поставка доступна в карточке и в каталоге моделей.
   * Печати нужной строки `--version` недостаточно для допуска произвольного файла.
   */
  async probe(config) {
    try {
      const binary = await verifyQwenPreviewBinary(qwenBin(config));

      await binary.descriptor.close();

      return { ok: true, version: QWEN_PREVIEW_VERSION };
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
  usagePresentation: {
    freshness: false,
    spentLabel: false,
    subscriptionQuotaUnavailable: true,
  },
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
  catalogCacheKey: (config) => `${readQwenSnapshot(config).fingerprint}:preview2-native-models`,
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
  commands: () => readUserSkillCommands({ bundlesOnly: true }),
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
      ? 'qwen-preview2-host' : 'qwen-preview2-bwrap-acp',
  },
  mcpStatus: () => ({ servers: [], note: 'MCP выдаётся сервером для каждого хода.' }),
  compaction: { kind: 'summary' },
  session: {
    mode: 'persistent',
    keepAlive: true,
    limitExempt: true,
    enabled: (spec: Record<string, unknown>) => !spec.factory && qwenHostEnabled(spec.providerSettings),
    fingerprint: qwenLiveFingerprint,
    open: openQwenLiveSession,
  },
  run: runQwenTurn,
};

export default adapter;
