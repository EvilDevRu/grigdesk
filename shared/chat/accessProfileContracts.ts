export interface AccessField {
  id: string;
  kind: 'secret' | 'text' | 'choice';
  label: string;
}

export interface AccessMethod {
  id: string;
  kind: 'api-key' | 'cli';
  label: string;
  mode?: string;
  fields: AccessField[];
  isolated: boolean;
  limitation?: string;
}

export interface AccessProfile {
  id: string;
  name: string;
  methodId: string;
  mode?: string;
  authState: 'ready' | 'needs-auth' | 'unavailable';
  revision: number;
  accessRevision: number;
  accountGeneration: number;
}

export interface AccessStep {
  id: string;
  label?: string;
  kind: 'fields' | 'open-url' | 'display-code' | 'enter-code' | 'choice'
    | 'waiting' | 'verifying' | 'result';
  message?: string;
  reason?: 'account_unknown' | 'account_mismatch';
  url?: string;
  code?: string;
  fields?: AccessField[];
  choices?: Array<{ id: string; label: string }>;
}

export interface AccessAttempt {
  id: string;
  profileId?: string;
  name: string;
  methodId: string;
  revision: number;
  expiresAt: string;
  state: string;
  step: AccessStep;
  error?: { code: string; message: string };
}

export interface AccessProfileList {
  revision: number;
  activeProfileId: string | null;
  switchAllowed: boolean;
  profiles: AccessProfile[];
  methods: AccessMethod[];
}

export interface AccessSnapshot {
  profileId: string;
  accessRevision: number;
  accountGeneration: number;
  scope: string;
}
