/**
 * Закрывает текущий документ через штатное поведение Electron.
 * Отдельный адаптер позволяет тесту не подменять cleanup окна happy-dom.
 */
export function closeCurrentWindow(): void {
  window.close();
}

