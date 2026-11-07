/**
 * Проверяет возможность перехода с открытого черновика.
 * Подтверждение требуется только при уходе с документа с локальными правками.
 */
export async function confirmDirtyRouteExit(dirty: boolean, changingDocument: boolean,
  approve: () => Promise<boolean>): Promise<boolean> {
  if (!dirty || !changingDocument) {
    return true;
  }

  return approve();
}
