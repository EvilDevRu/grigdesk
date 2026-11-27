import assert from 'node:assert/strict';

const ATTEMPT = 'a_0123456789abcdef0123456789abcdef';

/**
 * Выдаёт options редактора отдельно от runner telemetry графа.
 * Подтверждённая selection меняется только POST, поэтому загрузка графа не подменяет draft.
 */
export function stageSettingsOptions({
  task = 42, profile = 'project-alpha', attempt = ATTEMPT, node = 'plan', stage = 'PLAN',
  provider = 'claude', running = false,
} = {}) {
  const isClaude = provider === 'claude';
  const model = isClaude ? 'opus' : 'sol';
  const effort = isClaude ? 'max' : 'ultra';

  return {
    schema: 1,
    identity: {
      task: String(task),
      profile,
      attempt,
      node,
      stage
    },
    revision: 0,
    selection: {
      primary: null,
      parametersFor: provider,
      model: null,
      effort: null
    },
    sources: {
      primary: 'profile-stage',
      model: 'profile-stage',
      effort: 'profile-stage'
    },
    effective: {
      primary: provider,
      model,
      effort
    },
    chain: [provider, isClaude ? 'codex' : 'claude'],
    models: [
      {
        id: model,
        label: model,
        efforts: [effort, 'high'],
        aliases: []
      },
      {
        id: `${model}-other`,
        label: `${model}-other`,
        efforts: ['low', 'high'],
        aliases: []
      },
    ],
    catalogRevision: `catalog-${provider}-1`,
    actual: running ? {
      run: { id: 'run-current', epoch: 1 },
      provider: 'claude',
      model: 'opus',
      effort: 'high',
    } : null,
    receipt: null,
  };
}

/**
 * Находит действие по пользовательскому тексту, не закрепляя будущую CSS-структуру.
 * Отсутствие действия даёт короткий assert вместо дампа всего Vue wrapper.
 */
export function settingsButton(wrapper, pattern) {
  const button = wrapper.findAll('#stage-executors-panel button').find((item) => pattern.test(item.text()));

  if (!button) {
    assert.fail(`В редакторе нет действия ${pattern}`);
  }

  return button;
}

/**
 * Читает единый блок параметров на вкладке исполнителей.
 * Тесты находят актуальные поля после смены исполнителя или переоткрытия узла.
 */
export function settingsFields(wrapper) {
  return wrapper.get('#stage-executors-panel .executor-fields').findAll('select');
}
