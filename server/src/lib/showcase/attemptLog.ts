// Журнал попытки отсоединённого исполнителя: ход работы и её итог.
//
// Оба исполнителя раздела — запись браузера и установка голоса — отчитываются
// одинаково, и сервер читает их одним кодом. Поэтому и пишут они одним: разъезд
// форматов означал бы, что одна половина заданий перестала показывать ход, а
// заметили бы это не сразу.
//
// Правила журнала:
//  • номер строки растёт монотонно — по нему сервер отличает свежий отчёт от
//    догнавшего его старого; по времени этого делать нельзя;
//  • итог пишется атомарно: сервер читает его как готовый и по нему публикует
//    результат, а недописанный JSON увидеть не должен.
import { appendFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface AttemptLogOptions {
  attemptId: string;
  workDir: string;
}

export function createAttemptLog(options: AttemptLogOptions) {
  const progressFile = path.join(options.workDir, 'progress.jsonl');
  const resultFile = path.join(options.workDir, 'result.json');

  let sequence = 0;

  async function report(
    state: string,
    label: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    sequence += 1;

    const line = JSON.stringify({
      attemptId: options.attemptId,
      sequence,
      state,
      label,
      at: new Date().toISOString(),
      pid: process.pid,
      ...extra,
    });

    await appendFile(progressFile, `${line}\n`, 'utf8');
  }

  async function finish(outcome: Record<string, unknown>): Promise<void> {
    const temporary = `${resultFile}.tmp`;

    await writeFile(
      temporary,
      `${JSON.stringify({ attemptId: options.attemptId, ...outcome }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await rename(temporary, resultFile);
  }

  return { finish, report };
}
