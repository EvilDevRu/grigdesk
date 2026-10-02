// Снимок версии и обновления кокпита — `GET /api/system/version`. Его собирает
// `CockpitReleaseService` на сервере, а читают раздел «Настройки → Сервер» и плитка
// версии в конце рейки. Форма объявлена здесь, чтобы у веба и сервера не было двух
// копий одного DTO.

// Как показать версию человеку: подпись, стабильная часть и точный тег, если он есть.
export interface DisplayVersion {
  version: string;
  stableVersion: string | null;
  exactTag: string | null;
}

// Отказ проверки обновлений: наружу уходит код и текст, но не вывод git.
export interface ReleaseCheckError {
  code: string;
  message: string;
}

// Задание обновления. Его пишут и менеджер, и воркер, поэтому форма общая.
export interface UpdateJob extends Record<string, unknown> {
  id: string;
  kind?: string;
  status: string;
  stage?: string;
  targetSha?: string | null;
  previousRunningInstanceId?: string | null;
  expectedRuntimeBuildId?: string | null;
  previousRuntimeBuildId?: string | null;
  publicationStage?: string | null;
  backups?: Record<string, string | null> | null;
  error?: { code?: string; message?: string } | null;
  completedAt?: string | null;
}

// Снимок запущенного процесса: что именно сейчас исполняется и с какого момента.
export interface RunningRelease extends DisplayVersion {
  productVersion: string;
  versionTagMismatch: boolean;
  sha: string;
  instanceId: string;
  startedAt: string;
}

// Состояние рабочего дерева: где стоит checkout и можно ли его трогать.
export interface CheckoutState extends DisplayVersion {
  productVersion: string;
  versionTagMismatch: boolean;
  sha: string;
  branch: string | null;
  detached: boolean;
  dirty: boolean;
}

// Свежий опубликованный релиз по итогам последней проверки.
export interface LatestRelease {
  version: string;
  tag: string;
  sha: string;
  url: string | null;
}

/**
 * DTO раздела «Сервер»: одно и то же читают интерфейс и менеджер обновления.
 * Объявлен явно, а не выведен: без имени тип ссылался бы сам на себя через кеш.
 */
export interface ReleaseStatus {
  running: RunningRelease;
  checkout: CheckoutState;
  latest: LatestRelease | null;
  checkoutChanged: boolean;
  checkoutRelation: string;
  targetDescendsFromCheckout: boolean | null;
  updateAvailable: boolean;
  canApplyCheckout: boolean;
  canInstallRelease: boolean;
  applyBlockReasons: string[];
  installBlockReasons: string[];
  blockReasons: string[];
  checkedAt: string | null;
  checkError: ReleaseCheckError | null;
  job: UpdateJob | null;
}
