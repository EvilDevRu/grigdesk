import { showToast } from '../ui.ts';

/**
 * Маршрут и ленивый модал сообщают об отказе чанка одинаковым тостом.
 * Постоянный ID заменяет сообщение при повторной неудачной попытке открытия.
 */
export function showSectionLoadFailure(): void {
  showToast({
    id: 'section-load-failed',
    title: 'Не удалось открыть раздел. Закройте и снова запустите приложение.',
    tone: 'danger',
  });
}
