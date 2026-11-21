/**
 * Ждёт начала реального HTTP-сценария, пока иллюзия успеха невозможна без живого процесса.
 * Ранний выход даёт отдельную причину и не подвешивает отмену или проверку тайм-аута.
 */
export async function awaitCandidateRequest(
  received: Promise<void>,
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      received,
      exited.then(({ code, signal }) => {
        throw new Error('Кандидат завершился до запроса ' + String(code ?? signal));
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Кандидат не начал запрос за 1500 мс')), 1500);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
