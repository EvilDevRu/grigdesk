import type { WorkflowScope, WorkflowStep } from '../../../shared/pipeline/graphWorkflowContracts.ts';

/**
 * Применяет форму к одному локальному шагу выбранной области.
 * Ссылки в пределах области используют неизменяемый ID, подпись можно править.
 */
export function updateWorkflowStep(scope: WorkflowScope, id: string,
  patch: Partial<Omit<WorkflowStep, 'id'>>): WorkflowScope {
  return {
    ...scope,
    steps: scope.steps.map((step) => step.id === id ? { ...step, ...patch } : step),
  };
}

/**
 * Убирает узел только из выбранной области.
 * Его локальные ссылки и выходы исчезают в той же операции редактора.
 */
export function removeWorkflowStep(scope: WorkflowScope, id: string): WorkflowScope {
  return {
    returns: scope.returns.filter((value) => value !== id),
    steps: scope.steps.filter((step) => step.id !== id).map((step) => ({
      ...step,
      needs: step.needs?.filter((value) => value !== id),
      reads: step.reads?.filter((value) => value !== id),
      when: step.when?.source === id ? undefined : step.when,
      source: step.source === id ? undefined : step.source,
      retryFrom: step.retryFrom?.filter((target) => target !== id),
    })),
  };
}

/**
 * Применяет изменение зависимости в стабильном порядке списка.
 * Удалённая зависимость также удаляет использующий её вход или предикат.
 */
export function toggleWorkflowEdge(scope: WorkflowScope, step: WorkflowStep, source: string,
  enabled: boolean): WorkflowScope {
  const needs = new Set(step.needs ?? []);

  if (enabled) {
    needs.add(source);

    return updateWorkflowStep(scope, step.id, { needs: [...needs] });
  }

  needs.delete(source);

  return updateWorkflowStep(scope, step.id, {
    needs: [...needs],
    reads: step.reads?.filter((value) => value !== source),
    when: step.when?.source === source ? undefined : step.when,
    source: step.source === source ? undefined : step.source,
  });
}