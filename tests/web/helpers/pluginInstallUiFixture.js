import { isTerminalInstallJob } from '../../../web/src/shared/pluginInstall.ts';

/**
 * Reactive double использует тот же Vue singleton, что скомпилированный компонент.
 * Подменяется только сеть/store, реальные controls и dialog остаются в UI графе.
 */
export function pluginInstallUiDouble(reactive, initial = {}) {
  const calls = [];
  const state = reactive({
    job: null,
    versions: [],
    versionsUrl: '',
    versionsInputKey: '',
    versionsLoading: false,
    versionsError: null,
    busy: false,
    checking: false,
    error: null,
    recoveryError: null,
    reconciling: false,
    pendingAction: null,
    ...initial,
  });

  for (const method of [
    'loadJob', 'listVersions', 'startInstall', 'startUpdate', 'apply', 'cancel', 'rollback',
    'checkUpdates', 'reconcile',
  ]) {
    state[method] = async (...args) => {
      calls.push([method, JSON.parse(JSON.stringify(args))]);

      if (['startInstall', 'startUpdate', 'apply', 'rollback'].includes(method)) {
        state.busy = true;
      }
    };
  }

  state.invalidateVersions = (url) => {
    calls.push(['invalidateVersions', [url]]);
    state.versions = [];
    state.versionsUrl = '';
    state.versionsInputKey = url.trim();
  };
  state.forgetJob = () => {
    if (!isTerminalInstallJob(state.job) || state.busy || state.reconciling) {
      return false;
    }

    calls.push(['forgetJob', []]);
    state.job = null;

    return true;
  };

  return { state, calls };
}
