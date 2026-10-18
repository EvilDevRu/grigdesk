// Сравнение голосовых движков на фиксированном корпусе.
//
// Корпус НЕПЕРСОНАЛЬНЫЙ и одинаковый для всех: термины, числа, даты, омографы,
// длинная и короткая фраза. Реальные тексты задач сюда не попадают — сравнение
// не повод разослать рабочий материал всем настроенным поставщикам.
//
// Скрипт ничего не выбирает за человека: он собирает образцы, версии, задержку и
// предупреждения, а качество оценивается на слух. Совпадение расшифровки и один
// удачный абзац планкой «не отличить от живого человека» не являются.
import os from 'node:os';
import { dataHome } from '../../shared/runtime/dataHome.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalTextOf } from '../src/lib/showcase/voice/contract.ts';
import type { VoiceEngine } from '../src/lib/showcase/voice/contract.ts';
import { createVoiceRegistry } from '../src/lib/showcase/voice/registry.ts';
import { createPiperEngine } from '../src/lib/showcase/voice/piper.ts';
import { createQwenEngine } from '../src/lib/showcase/voice/qwen.ts';
import { createRhvoiceEngine } from '../src/lib/showcase/voice/rhvoice.ts';
import { createSileroEngine } from '../src/lib/showcase/voice/silero.ts';
import {
  qwenRuntimePaths,
  sileroRuntimePaths,
  voiceRuntimePaths,
} from '../src/lib/showcase/voice/install.ts';
import { checkSpeech } from '../src/lib/showcase/voice/speechCheck.ts';

interface BenchPhrase {
  id: string;
  what: string;
  text: string;
}

const CORPUS: BenchPhrase[] = [
  {
    id: 'short',
    what: 'короткая фраза',
    text: 'Открываем раздел.',
  },
  {
    id: 'terms',
    what: 'термины и латиница',
    text: 'Собранный ролик отдаётся в формате H.264 с дорожкой AAC.',
  },
  {
    id: 'numbers',
    what: 'числа и даты',
    text: 'Двадцать третьего мая проверка заняла сорок пять секунд вместо ста двадцати.',
  },
  {
    id: 'homographs',
    what: 'омографы',
    text: 'Замок на двери заперт, а замок на горе открыт для гостей.',
  },
  {
    id: 'long',
    what: 'длинная фраза',
    text: 'Раздел берёт готовую работу, предлагает сценарий по сценам, озвучивает его '
      + 'выбранным голосом, записывает браузер и собирает ролик с субтитрами, '
      + 'а человек принимает результат целиком.',
  },
];

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', '..', '.state', 'artifacts', 'showcase-bench');

interface PhraseResult {
  phraseId: string;
  what: string;
  file: string | null;
  latencyMs: number;
  ignoredDirections: string[];
  speechStatus: string;
  speechReason: string;
  error: string;
}

/**
 * Одна фраза одним движком. Отказ не прекращает прогон: сравнение полезно и тогда,
 * когда часть движков не отвечает, — важно видеть, кто именно и почему.
 */
async function runPhrase(engine: VoiceEngine, voiceId: string, phrase: BenchPhrase): Promise<PhraseResult> {
  const engineDir = path.join(outDir, engine.id, voiceId);
  const startedAt = Date.now();

  try {
    await mkdir(engineDir, { recursive: true });

    const candidate = await engine.synthesize(
      {
        canonicalText: canonicalTextOf(phrase.text),
        direction: {
          tone: null, pace: null, emphasis: [], pauses: [], stresses: [],
        },
        voiceRef: voiceId,
        language: 'ru',
      },
      { deadlineMs: 120_000, outputDir: engineDir },
    );
    const check = await checkSpeech({
      audioFile: candidate.temporaryFile,
      expectedText: phrase.text,
      // Расшифровка в bench не поднимается: она нужна для проверки конкретного
      // ролика, а здесь качество решает слух человека.
      transcribe: null,
    });

    return {
      phraseId: phrase.id,
      what: phrase.what,
      file: path.relative(outDir, candidate.temporaryFile),
      latencyMs: Date.now() - startedAt,
      ignoredDirections: candidate.ignoredDirections,
      speechStatus: check.status,
      speechReason: check.reason,
      error: '',
    };
  } catch (error) {
    return {
      phraseId: phrase.id,
      what: phrase.what,
      file: null,
      latencyMs: Date.now() - startedAt,
      ignoredDirections: [],
      speechStatus: 'skipped',
      speechReason: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Страница для прослушивания. Открывается файлом с диска, без сервера и внешних
 * ресурсов: образцы слушают там же, где их и получили.
 */
function renderPage(rows: { engine: string; voice: string; results: PhraseResult[] }[]): string {
  const blocks = rows.map((row) => {
    const items = row.results.map((result) => {
      const player = result.file
        ? `<audio controls preload="none" src="${result.file}"></audio>`
        : `<span class="fail">${result.error}</span>`;

      return `<tr><td>${result.what}</td><td>${player}</td>`
        + `<td>${result.latencyMs} мс</td><td>${result.speechReason || result.speechStatus}</td></tr>`;
    }).join('\n');

    return `<section><h2>${row.engine} · ${row.voice}</h2>
<table><thead><tr><th>Что проверяем</th><th>Образец</th><th>Задержка</th><th>Заметки</th></tr></thead>
<tbody>${items}</tbody></table></section>`;
  }).join('\n');

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>Сравнение голосов</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 32px; max-width: 1000px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 24px; }
  th, td { border-bottom: 1px solid #ddd; padding: 8px; text-align: left; vertical-align: middle; }
  .fail { color: #a33; }
  audio { width: 320px; }
</style></head><body>
<h1>Сравнение голосов</h1>
<p>Корпус одинаковый для всех движков и не содержит рабочих текстов.
Качество оценивается на слух: совпадение расшифровки его не доказывает.</p>
${blocks}
</body></html>`;
}

// Каталог локального синтеза берётся тот же, что и у раздела: сравнивать нужно
// установленный голос, а не свежесобранный ради сравнения.
const voiceDir = process.env.GRIGDESK_SHOWCASE_VOICE_DIR
  || path.join(dataHome({ env: process.env, home: os.homedir() }), 'state/showcase-voice');

async function main(): Promise<void> {
  // Тот же порядок, что у раздела. Фраза с латиницей у Silero честно даст отказ —
  // это тоже результат сравнения, а не сбой скрипта.
  const registry = createVoiceRegistry([
    createQwenEngine(qwenRuntimePaths(voiceDir)),
    createSileroEngine(sileroRuntimePaths(voiceDir)),
    createPiperEngine(voiceRuntimePaths(voiceDir)),
    createRhvoiceEngine(),
  ]);
  const statuses = await registry.statuses();
  const rows: { engine: string; voice: string; results: PhraseResult[] }[] = [];

  await mkdir(outDir, { recursive: true });

  for (const status of statuses) {
    if (status.doctor.status !== 'ready') {
      console.log(`${status.id}: пропущен — ${status.doctor.reason}`);

      if (status.doctor.install) {
        console.log(`  что нужно: ${status.doctor.install}`);
      }

      continue;
    }

    const engine = registry.engineOf(status.id);

    for (const voice of status.voices.filter((item) => item.available)) {
      console.log(`${status.id}:${voice.id} — синтезируем корпус…`);

      const results: PhraseResult[] = [];

      for (const phrase of CORPUS) {
        results.push(await runPhrase(engine, voice.id, phrase));
      }

      rows.push({ engine: status.name, voice: voice.id, results });
    }
  }

  const report = {
    startedAt: new Date().toISOString(),
    corpus: CORPUS.map((phrase) => ({ id: phrase.id, what: phrase.what })),
    rows,
  };

  await writeFile(path.join(outDir, 'bench.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outDir, 'index.html'), renderPage(rows), 'utf8');

  if (rows.length === 0) {
    console.log('Готовых движков нет: сравнивать нечего, и это тоже результат эксперимента.');

    return;
  }

  console.log(`Готово: ${path.join(outDir, 'index.html')}`);
}

await main();
