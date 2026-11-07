import type { ReleaseChannel } from './productReleaseVersion.ts';

export interface ApplicationUpdateSnapshot {
  channel: ReleaseChannel;
  running: string;
  targetVersion: string | null;
  notes: { ru: string; en: string } | null;
  scope: 'pair' | 'desktop';
  checkState: 'unknown' | 'checking' | 'current' | 'available' | 'error';
  checkedAt: string | null;
  error: string | null;
  job: {
    id: string;
    stage: string;
    version: string;
    scope: 'pair' | 'desktop';
    downloadedBytes: number | null;
    totalBytes: number | null;
    nextAction: string | null;
    recoverable?: boolean;
  } | null;
}

export interface ApplicationUpdatePort {
  state(): ApplicationUpdateSnapshot;
  subscribe(changed: () => void): () => void;
  action(action: string, body: Record<string, unknown>): Promise<void>;
}
