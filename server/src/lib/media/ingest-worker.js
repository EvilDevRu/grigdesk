// Фоновый воркер распознавания. Запускается отдельным (detached) процессом из
// startIngestJob: `node ingest-worker.js <путь к JSON-файлу задачи>`.
// Гоняет ingestRecording и переписывает файл задачи с результатом/ошибкой,
// чтобы b24_ingest_status мог опрашивать готовность. Сам процесс ничего не печатает.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { ingestRecording } from './ingest.js';

const statusPath = process.argv[2];

async function main() {
    const job = JSON.parse(readFileSync(statusPath, 'utf-8'));

    // Пока идёт распознавание, периодически перекладываем прогресс из
    // progress.json (его пишет transcribe.py) в статус-файл задачи.
    const progressFile = join(job.workDir, 'progress.json');
    const timer = setInterval(() => {
        try {
            if (!existsSync(progressFile)) {
                return;
            }
            job.progress = JSON.parse(readFileSync(progressFile, 'utf-8'));
            writeFileSync(statusPath, JSON.stringify(job));
        } catch {
            // прогресс — best-effort
        }
    }, 5000);

    try {
        job.result = await ingestRecording({
            filePath: job.filePath,
            workDir: job.workDir,
            model: job.model,
            lang: job.lang,
            frames: job.frames,
        });
        job.status = 'done';
    } catch (e) {
        job.status = 'failed';
        job.error = String(e?.message || e);
    } finally {
        clearInterval(timer);
    }
    job.finishedAt = Date.now();
    writeFileSync(statusPath, JSON.stringify(job));
}

main();
