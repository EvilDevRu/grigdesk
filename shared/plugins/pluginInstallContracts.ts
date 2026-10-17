// Установка пользовательских плагинов из источника (сейчас — git). Формы общие для
// сервера и веба: сервер их пишет, «Настройки → Плагины» читают.

// Источник плагина: вид стратегии и нормализованный адрес.
export interface PluginSourceRef {
  kind: string;
  url: string;
}

// Версия в источнике: число, тег и коммит, на который тег указывает.
export interface PluginVersionRef {
  version: string;
  tag: string;
  sha: string;
}

// Отказ словами: машинный код и текст для человека, без вывода команд.
export interface PluginInstallErrorInfo {
  code: string;
  message: string;
}

export type PluginInstallJobKind = 'install' | 'update' | 'rollback';

export type PluginInstallJobStatus =
  | 'running'
  | 'ready'
  | 'applying'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'recovery_required';

export type PluginInstallStage = 'fetching' | 'validating' | 'dependencies';

// Что заменит установка: ничего, управляемую версию или папку, положенную руками.
export type PluginInstallReplaces =
  | { kind: 'none' }
  | {
    kind: 'managed';
    version: string;
    sourceChanged: boolean;
  }
  | { kind: 'unmanaged' };

export interface PluginInstallCommit {
  sha: string;
  subject: string;
}

export interface PluginInstallChangedFile {
  status: string;
  path: string;
}

// Изменения между установленной и новой версией; `sensitive` — пути серверной части
// и зависимостей из `files`.
export interface PluginInstallChanges {
  commits: PluginInstallCommit[];
  files: PluginInstallChangedFile[];
  sensitive: string[];
  truncated: boolean;
}

// Карточка «что ставим»: заполняется к статусу ready.
export interface PluginInstallPreview {
  source: PluginSourceRef;
  target: PluginVersionRef;
  id: string;
  name: string;
  version: string;
  description: string;
  hasServer: boolean;
  hasWeb: boolean;
  replaces: PluginInstallReplaces;
  changes: PluginInstallChanges | null;
  warnings: string[];
}

export interface PluginInstallJob {
  id: string;
  kind: PluginInstallJobKind;
  pluginId: string | null;
  source: PluginSourceRef;
  target: PluginVersionRef | null;
  replaceModified: boolean;
  status: PluginInstallJobStatus;
  stage: PluginInstallStage | null;
  percent: number | null;
  preview: PluginInstallPreview | null;
  error: PluginInstallErrorInfo | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  revision: number;          // монотонная версия задания, для поздних HTTP-ответов
  reviewToken: string | null; // хэш готового пакета и снимка заменяемой установки
  backupRef: string | null;  // basename сохранённой replaced-копии после commit, без пути
}

// Самодостаточный снимок версии: при откате возвращается и прежний источник.
export interface PluginInstalledVersion {
  source: PluginSourceRef;
  version: string;
  tag: string;
  sha: string;
  installedAt: string;
  payloadDigest: string;     // дерево после npm, без корневой .git
  gitConfigDigest: string;   // известная конфигурация собственного клона
  npmDirs: string[];
}

export interface PluginInstallRecord extends PluginInstalledVersion {
  revision: number;          // новый номер при каждой публикации, в том числе откате
  previous: PluginInstalledVersion | null;
  latest: PluginVersionRef | null;
  checkedAt: string | null;
  checkError: PluginInstallErrorInfo | null;
}

// Запись плюс вычисленное на лету: её отдаёт `/api/plugins` в поле `install`.
export interface PluginInstallInfo extends PluginInstallRecord {
  updateAvailable: boolean;
  localChanges: boolean;
  restartRequired: boolean;
  rollbackAvailable: boolean;
  rollbackError: PluginInstallErrorInfo | null;
}
