export type SessionActivityReasonKind =
  'turn' | 'subagent' | 'command' | 'monitor' | 'workflow' | 'schedule' | 'goal' | 'unknown';

export interface SessionActivityReason {
  kind: SessionActivityReasonKind;
  count?: number;
  nextAt?: number;
}

export interface ChatSessionActivity {
  state: 'idle' | 'busy' | 'unknown';
  reasons: SessionActivityReason[];
}
