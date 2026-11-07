import { activeModalElement } from './modalEnvironment';

/**
 * Публичная проверка не раскрывает consumers внутренний реестр модальных слоёв.
 * Dock и немодальные панели не считаются препятствием для открытия настроек.
 */
export function hasOpenModal(): boolean {
  return activeModalElement() !== null;
}
