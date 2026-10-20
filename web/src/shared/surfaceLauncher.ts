import type { SurfaceTarget } from '../../../shared/desktop/surfaceContract.ts';
/**
 * Размещение выбирается по возможностям оболочки, не по имени операционной системы.
 * Отсутствие подтверждения не означает отсутствие уже созданного окна.
 */
export async function resolveSurfaceOpening(
  target: SurfaceTarget,
  supported: boolean,
  send: (target: SurfaceTarget) => Promise<unknown>,
): Promise<'window' | 'inline' | 'unknown'> {
  if (!supported) {
    return 'inline';
  }

  try {
    const result = await send(target);

    if (result && typeof result === 'object' && 'opened' in result) {
      if (result.opened === true) {
        return 'window';
      }
      if (result.opened === false) {
        return 'inline';
      }
    }
  }
  catch {
  }

  return 'unknown';
}
