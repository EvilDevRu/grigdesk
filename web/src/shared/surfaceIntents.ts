import type { SurfaceKind } from '../../../shared/web-log/surfacePerformance.ts';

export type SurfaceIntent = {
  kind: SurfaceKind;
  target: string;
  key: string
};
type Sink = (intent: SurfaceIntent) => () => void;

let sink: Sink | null = null;

/**
 * Единственный runtime документа принимает намерения, без импорта UI и stores обратно.
 * Старый disposer не снимает sink более нового runtime.
 */
export function setSurfaceIntentSink(value: Sink): () => void {
  sink = value;

  return () => {
    if (sink === value) {
      sink = null;
    }
  };
}

/**
 * Граница хранит непрозрачный ключ только для присоединения DOM, а не в журнале.
 * Неисправная диагностика не мешает монтированию или активации пользовательской панели.
 */
export function beginSurfaceIntent(intent: SurfaceIntent): () => void {
  try {
    return sink?.(intent) ?? (() => {});
  } catch {
    return () => {};
  }
}
