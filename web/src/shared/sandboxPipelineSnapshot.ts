import { shallowReadonly, shallowRef } from 'vue';
import type { PipelineNotice, PipelineTask, TaskObservation } from './pipelineContracts.ts';

export interface SandboxPipelineSnapshot {
  tasks: Pick<PipelineTask, 'task' | 'title' | 'profile' | 'readOnly' | 'daemonAlive' | 'result'>[];
  waiting: PipelineNotice[];
  stalled: PipelineNotice[];
  silent: PipelineNotice[];
  running: PipelineNotice[];
  observedByTask: Record<string, TaskObservation>;
  loadedAt: number;
  error: string | null;
}

const snapshot = shallowRef<SandboxPipelineSnapshot>({
  tasks: [],
  waiting: [],
  stalled: [],
  silent: [],
  running: [],
  observedByTask: {},
  loadedAt: 0,
  error: null,
});

export const sandboxPipelineSnapshot = shallowReadonly(snapshot);

/**
 * Передаёт виду уже прочитанный снимок конвейера целиком.
 * Канал не загружает данные и не владеет опросом или уведомлениями.
 */
export function publishSandboxPipelineSnapshot(value: SandboxPipelineSnapshot) {
  snapshot.value = value;
}

/**
 * Сохраняет последнюю успешную картину при отказе источника.
 * Ошибка позволяет виду честно обозначить устаревшие сведения.
 */
export function markSandboxPipelineSnapshotError(error: string) {
  snapshot.value = { ...snapshot.value, error };
}
