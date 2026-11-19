import type { ReleaseChannel } from './productReleaseVersion.ts';
import type { ReleaseDistributionSource } from './releaseChannelContracts.ts';

export interface ApplicationUpdateSnapshot {
  channel: ReleaseChannel;
  source?: ReleaseDistributionSource;
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

/**
 * Незавершённая offline-подготовка продолжается только исходным installer.
 * Ready и этапы применения остаются доступны штатному управлению.
 */
export function candidateNeedsInstaller(source?: ReleaseDistributionSource, stage?: string): boolean {
  return source === 'candidate-file'
    && ['queued', 'verifying', 'downloading', 'preparing', 'failed'].includes(stage ?? '');
}

export interface ApplicationUpdatePort {
  state(): ApplicationUpdateSnapshot;
  subscribe(changed: () => void): () => void;
  action(action: string, body: Record<string, unknown>): Promise<void>;
}
