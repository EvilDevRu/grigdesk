export type WindowControlAction = 'minimize' | 'toggle-maximize' | 'close';

export interface WindowControlsState {
  maximized: boolean;
}

/**
 * Локальная труба принимает только три команды управления главным окном.
 * Произвольные методы Electron и дополнительные параметры не входят в этот контракт.
 */
export function isWindowControlAction(value: unknown): value is WindowControlAction {
  return value === 'minimize' || value === 'toggle-maximize' || value === 'close';
}
