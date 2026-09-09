// Общие перечисления, идентификаторы и проверки контрактов аналитики фабрики.
import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical.js';

const freezeEnum = (...values) => Object.freeze(values);

export const ANALYTICS_ENUMS = Object.freeze({
  visitReason: freezeEnum(
    'initial',
    'forward_transition',
    'route_rewind',
    'gate_rejected',
    'human_rewind',
    'recovery',
  ),
  executionReason: freezeEnum('initial', 'no_result', 'product_failure', 'manual_resume'),
  runReason: freezeEnum('primary', 'provider_failover', 'model_fallback', 'manual_switch'),
  completeness: freezeEnum('complete', 'partial', 'missing', 'conflict'),
  clockFidelity: freezeEnum('monotonic', 'wall', 'derived'),
  lifecycleKind: freezeEnum(
    'orchestrator_session_started', 'orchestrator_session_finished',
    'lifecycle_tail_recovered',
    'attempt_started', 'attempt_interrupted', 'attempt_resumed', 'attempt_terminal_recorded',
    'route_selected', 'routing_transition_reconciled',
    'sandbox_started', 'sandbox_finished', 'bootstrap_started', 'bootstrap_finished',
    'node_visit_started', 'node_visit_finished',
    'node_execution_started', 'node_execution_finished',
    'command_started', 'command_finished',
    'dispatch_started', 'dispatch_candidate_selected', 'dispatch_candidate_skipped',
    'dispatch_finished', 'runner_started', 'runner_scope_bound', 'runner_finished',
    'runner_usage_recorded', 'runner_usage_reconciled', 'runner_abandoned',
    'failover_selected', 'runner_switch_requested', 'runner_switch_consumed',
    'runner_switch_rejected', 'gate_wait_started', 'gate_decided',
    'human_intervention_started', 'human_intervention_resolved',
    'cleanup_started', 'cleanup_finished', 'shared_lease_released',
  ),
});

const IDENTITY = Object.freeze({
  taskId: /^t[1-9][0-9]{0,18}$/,
  attemptId: /^a_[a-f0-9]{32}$/,
  orchestratorSessionId: /^os_[a-f0-9]{32}$/,
  nodeVisitId: /^nv_[a-f0-9]{32}$/,
  nodeExecutionId: /^ne_[a-f0-9]{32}$/,
  dispatchId: /^d_[a-f0-9]{32}$/,
  runId: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  spanId: /^sp_[a-f0-9]{32}$/,
  eventId: /^ev_[a-f0-9]{32}$/,
});

const ID_PREFIX = Object.freeze({
  orchestratorSessionId: 'os',
  nodeVisitId: 'nv',
  nodeExecutionId: 'ne',
  dispatchId: 'd',
  spanId: 'sp',
  eventId: 'ev',
});

export class AnalyticsContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AnalyticsContractError';
    this.code = 'analytics_contract_invalid';
  }
}

export function assertAnalyticsIdentity(kind, value) {
  const pattern = IDENTITY[kind];
  if (!pattern || typeof value !== 'string' || !pattern.test(value)) {
    throw new AnalyticsContractError(`${kind}: недопустимая analytics identity.`);
  }
  return value;
}

export function analyticsId(kind, tuple) {
  const prefix = ID_PREFIX[kind];
  if (!prefix || !Array.isArray(tuple) || tuple.length === 0) {
    throw new AnalyticsContractError(`${kind}: deterministic id contract не определён.`);
  }
  const digest = createHash('sha256')
    .update(canonicalJson([1, kind, tuple]), 'utf8')
    .digest('hex')
    .slice(0, 32);
  return assertAnalyticsIdentity(kind, `${prefix}_${digest}`);
}
