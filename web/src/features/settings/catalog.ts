import { translator } from '../../../../shared/i18n/catalogs.ts';
import type { FieldAddress } from './contracts.ts';

export interface SettingsGroup {
  id: string;
  label: string;
}

export interface SettingsPage {
  id: string;
  groupId: string;
  label: string;
  description: string;
}

export interface SettingsFieldMetadata {
  address: FieldAddress;
  label: string;
  description: string;
  synonyms?: string[];
  load?: boolean;
  available?: boolean;
}

export interface StaticSettingsField extends SettingsFieldMetadata {
  resourceId: string;
  key: string;
  control: 'switch' | 'number' | 'text' | 'textarea' | 'select' | 'custom';
  scope: string;
}

const PREFERENCE_DEFINITIONS = [
  [
    'automation.chats',
    'chatLiveSessions',
    'switch',
    translator.t('ru', 'settings.keepTheChatAgentAliveBetweenTurns'),
    translator.t('ru', 'settings.appliesToTheNextTurnIdleProcesses'),
  ],
  [
    'automation.chats',
    'chatAutoContinue',
    'switch',
    translator.t('ru', 'settings.continueATurnAutomaticallyAfterDisconnection'),
    translator.t('ru', 'settings.disablingCancelsFutureAttemptsTheCurrentTurn'),
  ],
  [
    'automation.context',
    'chatAutoCompactWindow',
    'number',
    translator.t('ru', 'settings.chatCompactionThresholdTokens'),
    translator.t('ru', 'settings.letTheProviderHandleCompactionAppliesTo'),
  ],
  [
    'automation.context',
    'stageAutoCompactWindow',
    'number',
    translator.t('ru', 'settings.pipelineStageCompactionThresholdTokens'),
    translator.t('ru', 'settings.separateThresholdForPipelineStagesLetThe'),
  ],
  [
    'automation.launch',
    'gitRefreshBeforeRun',
    'switch',
    translator.t('ru', 'settings.refreshRepositoriesBeforeStarting'),
    translator.t('ru', 'settings.appliesToNewTriageAndPipelineRuns'),
  ],
  [
    'automation.monitoring',
    'runSilenceWindow',
    'number',
    translator.t('ru', 'settings.turnSilenceThresholdMinutes'),
    translator.t('ru', 'settings.disableAlertsForAStalledPipelineTurn'),
  ],
  [
    'automation.arbiter',
    'arbiterAuto',
    'switch',
    translator.t('ru', 'settings.analyzeAutomatically'),
    translator.t('ru', 'settings.theArbiterAnalyzesPipelineStopsOnThe'),
  ],
  [
    'automation.arbiter',
    'arbiterModelRef',
    'select',
    translator.t('ru', 'settings.arbiterModel'),
    translator.t('ru', 'settings.providerAndModelAreSavedTogetherWith'),
  ],
  [
    'automation.arbiter',
    'arbiterEffort',
    'select',
    translator.t('ru', 'settings.arbiterEffort'),
    translator.t('ru', 'settings.availableLevelsComeFromTheSelectedModel'),
  ],
  [
    'agents.models',
    'showAllModels',
    'switch',
    translator.t('ru', 'settings.showAllModels'),
    translator.t('ru', 'settings.includeHiddenModelsAndOlderVersions'),
  ],
] as const;

export const SETTINGS_FIELDS: StaticSettingsField[] = PREFERENCE_DEFINITIONS.map(
  ([pageId, key, control, label, description]) => ({
    address: { pageId, fieldPath: [key] },
    resourceId: 'prefs',
    key,
    control,
    scope: translator.t('ru', 'settings.allDevices'),
    label,
    description,
  }),
);

interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PageRequest {
  pageId?: unknown;
  queryPage?: unknown;
  storage?: SettingsStorage;
}

const DEVICE_FIELDS = [
  [
    'interface.behavior',
    'wakeLock',
    'enabled',
    'switch',
    translator.t('ru', 'settings.keepScreenOn'),
    translator.t('ru', 'settings.theScreenStaysOnWhileTheApplication'),
  ],
  [
    'interface.notifications',
    'operations',
    'notificationTest',
    'custom',
    translator.t('ru', 'settings.systemNotifications'),
    translator.t('ru', 'settings.permissionAndATestNotificationAreRequested'),
  ],
  [
    'interface.shortcuts',
    'hotkeys',
    'overrides',
    'custom',
    translator.t('ru', 'settings.toolKeyboardShortcuts'),
    translator.t('ru', 'settings.shortcutsAreSavedWithApplyEscapeCancels'),
  ],
] as const;

SETTINGS_FIELDS.push(...DEVICE_FIELDS.map(([pageId, resourceId, key, control, label, description]) => ({
  address: { pageId, fieldPath: [key] },
  resourceId,
  key,
  control,
  label,
  description,
  scope: translator.t('ru', 'settings.thisDevice2'),
})));

SETTINGS_FIELDS.push({
  address: { pageId: 'system.diagnostics', fieldPath: ['level'] },
  resourceId: 'factoryDebug',
  key: 'level',
  control: 'select',
  label: translator.t('ru', 'settings.diagnosticLevel'),
  description: translator.t('ru', 'settings.appliesToTheServerAndWindowThe'),
  scope: translator.t('ru', 'settings.allDevices'),
});

const SPEECH_FIELDS = [
  [
    'speech.dictation',
    'engine',
    'select',
    translator.t('ru', 'settings.dictationEngine'),
    translator.t('ru', 'settings.browserOrWhisperOnTheGrigDeskServer'),
  ],
  [
    'speech.dictation',
    'browserProcessing',
    'select',
    translator.t('ru', 'settings.browserProcessing'),
    translator.t('ru', 'settings.localModeDoesNotAllowCloudProcessing'),
  ],
  [
    'speech.dictation',
    'quality',
    'select',
    translator.t('ru', 'settings.dictationQuality'),
    translator.t('ru', 'settings.presetForModelAndRecognitionDepth'),
  ],
  [
    'speech.video',
    'videoQuality',
    'select',
    translator.t('ru', 'settings.videoQuality'),
    translator.t('ru', 'settings.meetingRecordingRecognitionPreset'),
  ],
  [
    'speech.video',
    'videoInitialPrompt',
    'textarea',
    translator.t('ru', 'settings.videoStylePrompt'),
    translator.t('ru', 'settings.upToCharactersAShortExampleSets'),
  ],
  [
    'speech.language',
    'language',
    'select',
    translator.t('ru', 'settings.recognitionLanguage'),
    translator.t('ru', 'settings.automaticRussianOrEnglish'),
  ],
  [
    'speech.language',
    'dictionary',
    'textarea',
    translator.t('ru', 'settings.projectTerms'),
    translator.t('ru', 'settings.upToCharactersOneTermPerLine'),
  ],
  [
    'speech.advanced',
    'model',
    'select',
    translator.t('ru', 'settings.dictationModel'),
    translator.t('ru', 'settings.emptySelectionKeepsThePresetModel'),
  ],
  [
    'speech.advanced',
    'videoModel',
    'select',
    translator.t('ru', 'settings.videoModel'),
    translator.t('ru', 'settings.emptySelectionKeepsThePresetModel'),
  ],
  [
    'speech.advanced',
    'device',
    'select',
    translator.t('ru', 'settings.processingDevice'),
    translator.t('ru', 'settings.cudaIsAvailableOnlyAfterASuccessful'),
  ],
  [
    'speech.advanced',
    'computeType',
    'select',
    translator.t('ru', 'settings.computeType'),
    translator.t('ru', 'settings.emptySelectionKeepsTheDeviceDefault'),
  ],
  [
    'speech.advanced',
    'beamSize',
    'number',
    translator.t('ru', 'settings.dictationSearchDepth'),
    translator.t('ru', 'settings.fromToEmptyMeansPresetDefault'),
  ],
  [
    'speech.advanced',
    'vadSilenceMs',
    'number',
    translator.t('ru', 'settings.vadPauseMs'),
    translator.t('ru', 'settings.fromToMilliseconds'),
  ],
  [
    'speech.advanced',
    'conditionOnPreviousText',
    'switch',
    translator.t('ru', 'settings.usePreviousText'),
    translator.t('ru', 'settings.forDictationVideoTranscriptionUsesItsOwn'),
  ],
] as const;

SETTINGS_FIELDS.push(...SPEECH_FIELDS.map(([pageId, key, control, label, description]) => ({
  address: { pageId, fieldPath: [key] },
  resourceId: 'speech',
  key,
  control,
  label,
  description,
  scope: translator.t('ru', 'settings.allDevices'),
})));

const CONNECTION_FIELDS = [
  [
    'baseUrl',
    'text',
    translator.t('ru', 'settings.bPortalAddress'),
    translator.t('ru', 'settings.theFullAddressIsSavedTogetherWith'),
  ],
  [
    'login',
    'text',
    translator.t('ru', 'settings.bLogin'),
    translator.t('ru', 'settings.portalAccountForAllDevices'),
  ],
  [
    'password',
    'text',
    translator.t('ru', 'settings.bPassword'),
    translator.t('ru', 'settings.enterANewPasswordWheneverChangingThe'),
  ],
] as const;

SETTINGS_FIELDS.push(...CONNECTION_FIELDS.map(([key, control, label, description]) => ({
  address: { pageId: 'connections.b24', fieldPath: [key] },
  resourceId: 'b24',
  key,
  control,
  label,
  description,
  scope: translator.t('ru', 'settings.allDevices'),
})), {
  address: { pageId: 'system.startup', fieldPath: ['enabled'] },
  resourceId: 'autostart',
  key: 'enabled',
  control: 'switch',
  label: translator.t('ru', 'settings.startWhenTheMachineTurnsOn'),
  description: translator.t('ru', 'settings.configuresTheSystemdUnitOnThisMachine'),
  scope: translator.t('ru', 'settings.thisMachine'),
});

SETTINGS_FIELDS.push(...[
  [
    'name',
    translator.t('ru', 'settings.deviceName'),
    translator.t('ru', 'settings.applicationNameInTheMachineAccessList'),
  ],
  [
    'address',
    translator.t('ru', 'settings.machineAddress'),
    translator.t('ru', 'settings.optionalReachableAddressForThePairingString'),
  ],
].map(([key, label, description]) => ({
  address: { pageId: 'connections.devices', fieldPath: [key!] },
  resourceId: 'devicePairing',
  key: key!,
  control: 'text' as const,
  label: label!,
  description: description!,
  scope: translator.t('ru', 'settings.thisMachine'),
})));

export const SETTINGS_PAGE_KEY = 'grigdesk-settings-page';
export const DEFAULT_SETTINGS_PAGE = 'interface.behavior';

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: 'interface',
    label: translator.t('ru', 'settings.interface'),
  },
  {
    id: 'agents',
    label: translator.t('ru', 'settings.aiProviders'),
  },
  {
    id: 'automation',
    label: translator.t('ru', 'settings.chatsAndPipeline'),
  },
  {
    id: 'speech',
    label: translator.t('ru', 'settings.speechAndTranscription'),
  },
  {
    id: 'connections',
    label: translator.t('ru', 'settings.connectionsAndAccess'),
  },
  {
    id: 'plugins',
    label: translator.t('ru', 'settings.plugins'),
  },
  {
    id: 'system',
    label: translator.t('ru', 'settings.system2'),
  },
];

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  {
    id: 'interface.behavior',
    groupId: 'interface',
    label: translator.t('ru', 'settings.behavior'),
    description: translator.t('ru', 'settings.screenWakeLockOnThisDevice'),
  },
  {
    id: 'interface.notifications',
    groupId: 'interface',
    label: translator.t('ru', 'settings.notifications'),
    description: translator.t('ru', 'settings.permissionAndTestingForSystemNotifications'),
  },
  {
    id: 'interface.shortcuts',
    groupId: 'interface',
    label: translator.t('ru', 'settings.keyboardShortcuts'),
    description: translator.t('ru', 'settings.keyboardShortcutsForOpeningTools'),
  },
  {
    id: 'agents.providers',
    groupId: 'agents',
    label: translator.t('ru', 'settings.providers'),
    description: translator.t('ru', 'settings.providerAccessModelsParametersAndMCP'),
  },
  {
    id: 'agents.models',
    groupId: 'agents',
    label: translator.t('ru', 'settings.models'),
    description: translator.t('ru', 'settings.visibilityOfHiddenModelsAndOlderVersions'),
  },
  {
    id: 'automation.chats',
    groupId: 'automation',
    label: translator.t('ru', 'settings.chats'),
    description: translator.t('ru', 'settings.liveSessionsAndContinuationAfterDisconnection'),
  },
  {
    id: 'automation.context',
    groupId: 'automation',
    label: translator.t('ru', 'settings.context'),
    description: translator.t('ru', 'settings.separateCompactionThresholdsForChatAndPipeline'),
  },
  {
    id: 'automation.launch',
    groupId: 'automation',
    label: translator.t('ru', 'settings.startup'),
    description: translator.t('ru', 'settings.repositoryRefreshBeforeStarting'),
  },
  {
    id: 'automation.monitoring',
    groupId: 'automation',
    label: translator.t('ru', 'settings.monitoring'),
    description: translator.t('ru', 'settings.pipelineTurnSilenceThreshold'),
  },
  {
    id: 'automation.arbiter',
    groupId: 'automation',
    label: translator.t('ru', 'settings.arbiter'),
    description: translator.t('ru', 'settings.automaticStopAnalysisModelAndEffort'),
  },
  {
    id: 'speech.dictation',
    groupId: 'speech',
    label: translator.t('ru', 'settings.dictation2'),
    description: translator.t('ru', 'settings.dictationEngineProcessingLocationAndQuality'),
  },
  {
    id: 'speech.video',
    groupId: 'speech',
    label: translator.t('ru', 'settings.videoTranscription'),
    description: translator.t('ru', 'settings.transcriptionQualityAndStylePrompt'),
  },
  {
    id: 'speech.language',
    groupId: 'speech',
    label: translator.t('ru', 'settings.languageAndTerms'),
    description: translator.t('ru', 'settings.recognitionLanguageAndTermDictionary'),
  },
  {
    id: 'speech.models',
    groupId: 'speech',
    label: translator.t('ru', 'settings.localModels'),
    description: translator.t('ru', 'settings.modelCatalogDownloadsAndCopying'),
  },
  {
    id: 'speech.advanced',
    groupId: 'speech',
    label: translator.t('ru', 'settings.advancedParameters'),
    description: translator.t('ru', 'settings.modelsDeviceEnvironmentAndPerformanceMeasurement'),
  },
  {
    id: 'connections.b24',
    groupId: 'connections',
    label: translator.t('ru', 'settings.bitrix'),
    description: translator.t('ru', 'settings.portalCredentialsAndConnectionTesting'),
  },
  {
    id: 'connections.devices',
    groupId: 'connections',
    label: translator.t('ru', 'settings.applicationDevices'),
    description: translator.t('ru', 'settings.applicationPairingQRDeviceNameAndMachine'),
  },
  {
    id: 'connections.mobile',
    groupId: 'connections',
    label: translator.t('ru', 'settings.phoneAndAccess'),
    description: translator.t('ru', 'settings.relaysDevicePairingAndLoginOnThis'),
  },
  {
    id: 'plugins.installed',
    groupId: 'plugins',
    label: translator.t('ru', 'settings.installed'),
    description: translator.t('ru', 'settings.pluginActivationParametersSourceAndReadiness'),
  },
  {
    id: 'plugins.install',
    groupId: 'plugins',
    label: translator.t('ru', 'settings.installation'),
    description: translator.t('ru', 'settings.installingAPluginFromGitAndRecovering'),
  },
  {
    id: 'system.startup',
    groupId: 'system',
    label: translator.t('ru', 'settings.systemStartup'),
    description: translator.t('ru', 'settings.autostartShortcutAndServerProcessStatus'),
  },
  {
    id: 'system.updates',
    groupId: 'system',
    label: translator.t('ru', 'settings.updates'),
    description: translator.t('ru', 'settings.versionsApplyingUpdatesAndRebuildingTheInterface'),
  },
  {
    id: 'system.diagnostics',
    groupId: 'system',
    label: translator.t('ru', 'settings.diagnostics'),
    description: translator.t('ru', 'settings.diagnosticLevelProblemMarkersAndWindowLog'),
  },
  {
    id: 'system.processes',
    groupId: 'system',
    label: translator.t('ru', 'settings.processes'),
    description: translator.t('ru', 'settings.liveAgentsOpeningChatsAndStoppingProcesses'),
  },
];

/**
 * Хранилище может быть запрещено политикой браузера или приватным режимом.
 * Его отказ не мешает открыть настройки и перейти к следующему источнику страницы.
 */
function readStoredPage(storage: SettingsStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Старое имя вкладки читается только при открытии и отсутствии нового ключа.
 * Запись переноса предшествует удалению, чтобы отказ storage не терял предпочтение.
 */
function migrateLegacyPage(storage: SettingsStorage): string | undefined {
  const legacyKey = 'grigdesk-settings-tab';
  const legacyPages = new Map([
    ['app', 'interface.behavior'],
    ['speech', 'speech.dictation'],
    ['b24', 'connections.b24'],
    ['providers', 'agents.providers'],
    ['runs', 'automation.chats'],
    ['plugins', 'plugins.installed'],
    ['server', 'system.startup'],
    ['access', 'connections.mobile'],
  ]);
  const tab = readStoredPage(storage, legacyKey);
  const page = legacyPages.get(tab ?? '');

  if (tab !== null) {
    try {
      storage.setItem(SETTINGS_PAGE_KEY, page ?? DEFAULT_SETTINGS_PAGE);
      storage.removeItem(legacyKey);
    } catch {
      // Разовый выбор работает в памяти даже при недоступном хранилище.
    }
  }

  return page;
}

/**
 * Приоритет источников фиксирован и не зависит от порядка монтирования страниц.
 * Неизвестные ID не разрешаются в импорт и не затирают сохранённую страницу.
 */
export function resolveSettingsPage(request: PageRequest = {}): string {
  const saved = request.storage ? readStoredPage(request.storage, SETTINGS_PAGE_KEY) : null;
  const migrated = request.storage && saved === null ? migrateLegacyPage(request.storage) : undefined;
  const candidates = [request.pageId, request.queryPage, saved, migrated];

  return candidates.find((id) => SETTINGS_PAGES.some((page) => page.id === id)) as string
    ?? DEFAULT_SETTINGS_PAGE;
}

/**
 * Адрес сохраняет отдельные сегменты и получает собственную копию пути.
 * Допустимость динамического поля проверяет владелец каталога после загрузки сущности.
 */
export function resolveFieldAddress(address: FieldAddress): FieldAddress | null {
  if (!SETTINGS_PAGES.some((page) => page.id === address.pageId)
      || !Array.isArray(address.fieldPath) || address.fieldPath.length === 0
      || address.fieldPath.some((part) => typeof part !== 'string' || part.length === 0)) {
    return null;
  }

  return { ...address, fieldPath: [...address.fieldPath] };
}

/**
 * Точки и слеши внутри ID и пути являются частью имени поля, а не разделителями.
 * Отсутствующая цель не совпадает с полем и не запускает его раскрытие.
 */
export function equalFieldAddress(left: FieldAddress | null, right: FieldAddress | null): boolean {
  return Boolean(left && right && left.pageId === right.pageId && left.entityId === right.entityId
    && left.tabId === right.tabId && left.fieldPath.length === right.fieldPath.length
    && left.fieldPath.every((part, index) => part === right.fieldPath[index]));
}

const GROUP_MESSAGES: Record<string, Record<string, string>> = {
  "interface": {
    "label": "settings.interface"
  },
  "agents": {
    "label": "settings.aiProviders"
  },
  "automation": {
    "label": "settings.chatsAndPipeline"
  },
  "speech": {
    "label": "settings.speechAndTranscription"
  },
  "connections": {
    "label": "settings.connectionsAndAccess"
  },
  "plugins": {
    "label": "settings.plugins"
  },
  "system": {
    "label": "settings.system2"
  }
};

const PAGE_MESSAGES: Record<string, Record<string, string>> = {
  "interface.behavior": {
    "label": "settings.behavior",
    "description": "settings.screenWakeLockOnThisDevice"
  },
  "interface.notifications": {
    "label": "settings.notifications",
    "description": "settings.permissionAndTestingForSystemNotifications"
  },
  "interface.shortcuts": {
    "label": "settings.keyboardShortcuts",
    "description": "settings.keyboardShortcutsForOpeningTools"
  },
  "agents.providers": {
    "label": "settings.providers",
    "description": "settings.providerAccessModelsParametersAndMCP"
  },
  "agents.models": {
    "label": "settings.models",
    "description": "settings.visibilityOfHiddenModelsAndOlderVersions"
  },
  "automation.chats": {
    "label": "settings.chats",
    "description": "settings.liveSessionsAndContinuationAfterDisconnection"
  },
  "automation.context": {
    "label": "settings.context",
    "description": "settings.separateCompactionThresholdsForChatAndPipeline"
  },
  "automation.launch": {
    "label": "settings.startup",
    "description": "settings.repositoryRefreshBeforeStarting"
  },
  "automation.monitoring": {
    "label": "settings.monitoring",
    "description": "settings.pipelineTurnSilenceThreshold"
  },
  "automation.arbiter": {
    "label": "settings.arbiter",
    "description": "settings.automaticStopAnalysisModelAndEffort"
  },
  "speech.dictation": {
    "label": "settings.dictation2",
    "description": "settings.dictationEngineProcessingLocationAndQuality"
  },
  "speech.video": {
    "label": "settings.videoTranscription",
    "description": "settings.transcriptionQualityAndStylePrompt"
  },
  "speech.language": {
    "label": "settings.languageAndTerms",
    "description": "settings.recognitionLanguageAndTermDictionary"
  },
  "speech.models": {
    "label": "settings.localModels",
    "description": "settings.modelCatalogDownloadsAndCopying"
  },
  "speech.advanced": {
    "label": "settings.advancedParameters",
    "description": "settings.modelsDeviceEnvironmentAndPerformanceMeasurement"
  },
  "connections.b24": {
    "label": "settings.bitrix",
    "description": "settings.portalCredentialsAndConnectionTesting"
  },
  "connections.devices": {
    "label": "settings.applicationDevices",
    "description": "settings.applicationPairingQRDeviceNameAndMachine"
  },
  "connections.mobile": {
    "label": "settings.phoneAndAccess",
    "description": "settings.relaysDevicePairingAndLoginOnThis"
  },
  "plugins.installed": {
    "label": "settings.installed",
    "description": "settings.pluginActivationParametersSourceAndReadiness"
  },
  "plugins.install": {
    "label": "settings.installation",
    "description": "settings.installingAPluginFromGitAndRecovering"
  },
  "system.startup": {
    "label": "settings.systemStartup",
    "description": "settings.autostartShortcutAndServerProcessStatus"
  },
  "system.updates": {
    "label": "settings.updates",
    "description": "settings.versionsApplyingUpdatesAndRebuildingTheInterface"
  },
  "system.diagnostics": {
    "label": "settings.diagnostics",
    "description": "settings.diagnosticLevelProblemMarkersAndWindowLog"
  },
  "system.processes": {
    "label": "settings.processes",
    "description": "settings.liveAgentsOpeningChatsAndStoppingProcesses"
  }
};

const FIELD_MESSAGES: Record<string, Record<string, string>> = {
  "prefs:chatLiveSessions": {
    "label": "settings.keepTheChatAgentAliveBetweenTurns",
    "description": "settings.appliesToTheNextTurnIdleProcesses",
    "scope": "settings.allDevices"
  },
  "prefs:chatAutoContinue": {
    "label": "settings.continueATurnAutomaticallyAfterDisconnection",
    "description": "settings.disablingCancelsFutureAttemptsTheCurrentTurn",
    "scope": "settings.allDevices"
  },
  "prefs:chatAutoCompactWindow": {
    "label": "settings.chatCompactionThresholdTokens",
    "description": "settings.letTheProviderHandleCompactionAppliesTo",
    "scope": "settings.allDevices"
  },
  "prefs:stageAutoCompactWindow": {
    "label": "settings.pipelineStageCompactionThresholdTokens",
    "description": "settings.separateThresholdForPipelineStagesLetThe",
    "scope": "settings.allDevices"
  },
  "prefs:gitRefreshBeforeRun": {
    "label": "settings.refreshRepositoriesBeforeStarting",
    "description": "settings.appliesToNewTriageAndPipelineRuns",
    "scope": "settings.allDevices"
  },
  "prefs:runSilenceWindow": {
    "label": "settings.turnSilenceThresholdMinutes",
    "description": "settings.disableAlertsForAStalledPipelineTurn",
    "scope": "settings.allDevices"
  },
  "prefs:arbiterAuto": {
    "label": "settings.analyzeAutomatically",
    "description": "settings.theArbiterAnalyzesPipelineStopsOnThe",
    "scope": "settings.allDevices"
  },
  "prefs:arbiterModelRef": {
    "label": "settings.arbiterModel",
    "description": "settings.providerAndModelAreSavedTogetherWith",
    "scope": "settings.allDevices"
  },
  "prefs:arbiterEffort": {
    "label": "settings.arbiterEffort",
    "description": "settings.availableLevelsComeFromTheSelectedModel",
    "scope": "settings.allDevices"
  },
  "prefs:showAllModels": {
    "label": "settings.showAllModels",
    "description": "settings.includeHiddenModelsAndOlderVersions",
    "scope": "settings.allDevices"
  },
  "wakeLock:enabled": {
    "label": "settings.keepScreenOn",
    "description": "settings.theScreenStaysOnWhileTheApplication",
    "scope": "settings.thisDevice2"
  },
  "operations:notificationTest": {
    "label": "settings.systemNotifications",
    "description": "settings.permissionAndATestNotificationAreRequested",
    "scope": "settings.thisDevice2"
  },
  "hotkeys:overrides": {
    "label": "settings.toolKeyboardShortcuts",
    "description": "settings.shortcutsAreSavedWithApplyEscapeCancels",
    "scope": "settings.thisDevice2"
  },
  "factoryDebug:level": {
    "label": "settings.diagnosticLevel",
    "description": "settings.appliesToTheServerAndWindowThe",
    "scope": "settings.allDevices"
  },
  "speech:engine": {
    "label": "settings.dictationEngine",
    "description": "settings.browserOrWhisperOnTheGrigDeskServer",
    "scope": "settings.allDevices"
  },
  "speech:browserProcessing": {
    "label": "settings.browserProcessing",
    "description": "settings.localModeDoesNotAllowCloudProcessing",
    "scope": "settings.allDevices"
  },
  "speech:quality": {
    "label": "settings.dictationQuality",
    "description": "settings.presetForModelAndRecognitionDepth",
    "scope": "settings.allDevices"
  },
  "speech:videoQuality": {
    "label": "settings.videoQuality",
    "description": "settings.meetingRecordingRecognitionPreset",
    "scope": "settings.allDevices"
  },
  "speech:videoInitialPrompt": {
    "label": "settings.videoStylePrompt",
    "description": "settings.upToCharactersAShortExampleSets",
    "scope": "settings.allDevices"
  },
  "speech:language": {
    "label": "settings.recognitionLanguage",
    "description": "settings.automaticRussianOrEnglish",
    "scope": "settings.allDevices"
  },
  "speech:dictionary": {
    "label": "settings.projectTerms",
    "description": "settings.upToCharactersOneTermPerLine",
    "scope": "settings.allDevices"
  },
  "speech:model": {
    "label": "settings.dictationModel",
    "description": "settings.emptySelectionKeepsThePresetModel",
    "scope": "settings.allDevices"
  },
  "speech:videoModel": {
    "label": "settings.videoModel",
    "description": "settings.emptySelectionKeepsThePresetModel",
    "scope": "settings.allDevices"
  },
  "speech:device": {
    "label": "settings.processingDevice",
    "description": "settings.cudaIsAvailableOnlyAfterASuccessful",
    "scope": "settings.allDevices"
  },
  "speech:computeType": {
    "label": "settings.computeType",
    "description": "settings.emptySelectionKeepsTheDeviceDefault",
    "scope": "settings.allDevices"
  },
  "speech:beamSize": {
    "label": "settings.dictationSearchDepth",
    "description": "settings.fromToEmptyMeansPresetDefault",
    "scope": "settings.allDevices"
  },
  "speech:vadSilenceMs": {
    "label": "settings.vadPauseMs",
    "description": "settings.fromToMilliseconds",
    "scope": "settings.allDevices"
  },
  "speech:conditionOnPreviousText": {
    "label": "settings.usePreviousText",
    "description": "settings.forDictationVideoTranscriptionUsesItsOwn",
    "scope": "settings.allDevices"
  },
  "b24:baseUrl": {
    "label": "settings.bPortalAddress",
    "description": "settings.theFullAddressIsSavedTogetherWith",
    "scope": "settings.allDevices"
  },
  "b24:login": {
    "label": "settings.bLogin",
    "description": "settings.portalAccountForAllDevices",
    "scope": "settings.allDevices"
  },
  "b24:password": {
    "label": "settings.bPassword",
    "description": "settings.enterANewPasswordWheneverChangingThe",
    "scope": "settings.allDevices"
  },
  "autostart:enabled": {
    "label": "settings.startWhenTheMachineTurnsOn",
    "description": "settings.configuresTheSystemdUnitOnThisMachine",
    "scope": "settings.thisMachine"
  },
  "devicePairing:name": {
    "label": "settings.deviceName",
    "description": "settings.applicationNameInTheMachineAccessList",
    "scope": "settings.thisMachine"
  },
  "devicePairing:address": {
    "label": "settings.machineAddress",
    "description": "settings.optionalReachableAddressForThePairingString",
    "scope": "settings.thisMachine"
  }
};

/**
 * Исходные экспорты остаются русским публичным каталогом со стабильными ID.
 * Представление получает новую копию подписей, не меняя адреса и значения полей.
 */
export function getSettingsGroups(locale = 'ru'): SettingsGroup[] {
  return SETTINGS_GROUPS.map((group) => ({
    ...group,
    label: translator.t(locale, GROUP_MESSAGES[group.id]!.label!),
  }));
}

/**
 * Проекция переводит подписи страниц по стабильным ID, сохраняя исходный каталог.
 * Старый экспорт по-прежнему содержит только русские строки прежней формы.
 */
export function getSettingsPages(locale = 'ru'): SettingsPage[] {
  return SETTINGS_PAGES.map((page) => ({
    ...page,
    label: translator.t(locale, PAGE_MESSAGES[page.id]!.label!),
    description: translator.t(locale, PAGE_MESSAGES[page.id]!.description!),
  }));
}

/**
 * Метаданные поля переводятся отдельно от адреса, ключа ресурса и значения.
 * Поиск получает новую проекцию без перерегистрации черновиков настроек.
 */
export function getSettingsFields(locale = 'ru'): StaticSettingsField[] {
  return SETTINGS_FIELDS.map((field) => {
    const keys = FIELD_MESSAGES[field.resourceId + ':' + field.key]!;

    return {
      ...field,
      label: translator.t(locale, keys.label!),
      description: translator.t(locale, keys.description!),
      scope: translator.t(locale, keys.scope!),
    };
  });
}
