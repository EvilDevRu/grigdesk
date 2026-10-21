import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { messageLabels } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';

export const ACTIVE_UPDATE_STATES = new Set([
  'queued', 'preparing', 'installing', 'building', 'testing', 'applying', 'restarting',
]);

const UPDATE_STAGE_MESSAGES = {
  queued: 'core.jobQueued',
  preparing: 'core.checkingConditionsAndPreparingASnapshot',
  installing: 'core.installingDependencies',
  building: 'core.buildingWeb',
  testing: 'core.runningSmokeTest',
  applying: 'core.publishingPreparedBuild',
  restarting: 'core.restartingGrigDesk',
  done: 'core.updateApplied',
  failed: 'core.updateFailed',
};

export const UPDATE_STAGE_LABELS = messageLabels(UPDATE_STAGE_MESSAGES, uiLocalePort);

// Те же стадии одним-двумя словами — для плитки версии в конце рейки, где полная фраза
// не помещается. Полная остаётся во всплывашке и в настройках.
const UPDATE_STAGE_SHORT_MESSAGES = {
  queued: 'core.queued',
  preparing: 'core.preparingSnapshot',
  installing: 'core.dependencies',
  building: 'core.buildingWeb',
  testing: 'core.smokeTest',
  applying: 'core.publishingBuild',
  restarting: 'core.restarting',
};

export const UPDATE_STAGE_SHORT_LABELS = messageLabels(UPDATE_STAGE_SHORT_MESSAGES, uiLocalePort);

const BLOCK_REASON_MESSAGES = {
  packaged_update_requires_package: 'core.installTheNewGrigDeskPackage',
  no_release_checked: 'core.checkPublishedReleasesFirst',
  branch_not_main: 'core.aReleaseCanOnlyBeInstalledOn',
  detached_head: 'core.checkoutIsInDetachedHEAD',
  working_tree_dirty: 'core.checkoutContainsUncommittedOrUntrackedFiles',
  checkout_ahead: 'core.localMainIsAheadOfTheSelected',
  checkout_diverged: 'core.checkoutHistoryDivergesFromTheSelectedRelease',
  checkout_at_release: 'core.theSelectedReleaseIsAlreadyInThe',
  release_not_newer: 'core.thePublishedReleaseIsNotNewerThan',
  update_in_progress: 'core.anotherUpdateJobIsAlreadyRunning',
  version_tag_mismatch: 'core.versionDoesNotMatchTheCheckoutS',
  dirty_apply_not_supported: 'core.cannotApplyADirtyCheckoutAutomaticallyCommit',
};

export const BLOCK_REASON_LABELS = messageLabels(BLOCK_REASON_MESSAGES, uiLocalePort);

export function grigDeskUpdateTone(status) {
  if (status?.job?.status === 'failed') return 'error';
  if (status?.checkoutChanged) return 'checkout';
  if (status?.updateAvailable) return 'release';
  return '';
}

/**
 * Известная причина обновления разрешается при построении представления.
 * Неизвестный код остаётся параметром собственной поясняющей подписи.
 */
export function blockReasonLabel(code,
  locale = 'ru',
) {
  const t = localeTranslator(locale);

  return BLOCK_REASON_MESSAGES[code]
    ? t(BLOCK_REASON_MESSAGES[code]) : t('core.updateBlocked', { code });
}
