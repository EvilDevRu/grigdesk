import { promises as fs } from 'node:fs';
import path from 'node:path';

// Артефакты прогона — в архив своего же каталога состояния: чего нет, то и не
// переносится. Доверенный журнал попытки здесь не участвует и не принадлежит
// GrigDesk: t<id>.pipeline — лишь его проекция для интерфейса.
const TASK_ARTIFACTS = ['pipeline', 'env', 'stage', 'plan.md', 'recon.md', 'diag.md',
  'ship.md', 'report.md', 'tests.sha256', 'instrumentation-scope.list'];

// Режим «цикл»: отчёт на каждый визит исполнителя и исходный замер задачи. Отчёты
// сданных визитов закрыты на запись — оставленные на месте, они перегородили бы
// следующей попытке задачи её же первый круг.
const LOOP_ARTIFACT_RE = /^report\.r\d{1,3}(?:\.v\d{1,4})?\.md$|^baseline\.md$/;

/**
 * Переносит артефакты прогона задачи в `archive/` того же каталога состояния и
 * возвращает суффиксы перенесённого. Отсутствующий файл — не ошибка: down.sh мог
 * уже перенести его сам. Отчёты цикла ищутся по имени, их число не известно заранее.
 */
export async function archiveTaskFiles(id: string, stateDir: string): Promise<string[]> {
  const moved: string[] = [];
  await fs.mkdir(path.join(stateDir, 'archive'), { recursive: true });
  const loopArtifacts = (await fs.readdir(stateDir))
    .filter((name) => name.startsWith(`t${id}.`))
    .map((name) => name.slice(`t${id}.`.length))
    .filter((suffix) => LOOP_ARTIFACT_RE.test(suffix))
    .sort();

  for (const suffix of [...TASK_ARTIFACTS, ...loopArtifacts]) {
    const from = path.join(stateDir, `t${id}.${suffix}`);
    try {
      await fs.rename(from, path.join(stateDir, 'archive', `t${id}.${suffix}`));
      moved.push(suffix);
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== 'ENOENT') throw err;
    }
  }
  return moved;
}
