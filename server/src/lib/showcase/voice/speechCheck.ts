// Самопроверка речи: сверка синтезированного звука с тем, что должно было
// прозвучать.
//
// Проверка РЕКОМЕНДАТЕЛЬНАЯ. Совпадение расшифровки не доказывает ни правильного
// ударения, ни естественной интонации, ни отсутствия смысловой ошибки — оно ловит
// только грубое: пропущенное слово, тишину вместо речи, обрыв и перегруз.
//
// Недоступная расшифровка даёт `skipped`, а не «прошло»: непроверенное место
// человек должен услышать сам, и красить его в зелёный нельзя.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { SpeechTranscript } from '../../speech/transport.ts';

const run = promisify(execFile);

export interface SpeechCheckInput {
  audioFile: string;
  expectedText: string;
  // Расшифровку делает общий речевой runtime GrigDesk. Она внедряется функцией:
  // раздел не должен знать, как именно устроен запуск распознавания, а тесты —
  // поднимать его целиком ради сверки токенов.
  transcribe: ((file: string) => Promise<string | SpeechTranscript>) | null;
}

export interface SpeechCheckResult {
  status: 'passed' | 'warning' | 'skipped';
  reason: string;
  durationMs: number;
  // Конкретные пропущенные слова показываются даже при малом общем расхождении:
  // одно потерянное «не» меняет смысл целиком, а доля расхождения этого не видит.
  missingWords: string[];
  loudnessWarning: string;
  // Тот же результат ASR затем используется для синхронизации. `null` означает,
  // что проверка работала по старому строковому порту либо распознавание не
  // состоялось; второй Whisper ради таймкодов запускать нельзя.
  transcript: SpeechTranscript | null;
}

// Порог расхождения слов, после которого место считается спорным. Он рабочий,
// а не выверенный по корпусу: корпус собирается вместе с выбором движка, и до
// этого числу нельзя приписывать точность, которой у него нет.
const MISMATCH_LIMIT = 0.15;

/**
 * Нормализация для сравнения: убираются знаки, регистр и «ё», потому что ни один
 * из них не влияет на то, ЧТО прозвучало. Всё остальное сохраняется — сравнивать
 * приблизительно значило бы пропускать настоящие пропуски.
 */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^a-zа-я0-9\s-]/gi, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Слова, которых нет в расшифровке. Считается по мультимножеству: повтор слова в
 * ожидании требует такого же повтора в услышанном, иначе пропуск второго «нет»
 * остался бы незамеченным.
 */
export function missingFrom(expected: string[], heard: string[]): string[] {
  const pool = new Map<string, number>();

  for (const word of heard) {
    pool.set(word, (pool.get(word) ?? 0) + 1);
  }

  const missing: string[] = [];

  for (const word of expected) {
    const left = pool.get(word) ?? 0;

    if (left > 0) {
      pool.set(word, left - 1);
    } else {
      missing.push(word);
    }
  }

  return missing;
}

interface AudioStats {
  durationMs: number;
  peakDb: number;
  meanDb: number;
}

/**
 * Детерминированные показатели дорожки. Они не требуют распознавания и работают
 * всегда: тишина вместо речи и перегруз слышны в цифрах раньше, чем в словах.
 */
export async function audioStats(file: string): Promise<AudioStats> {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner', '-nostats',
    '-i', file,
    '-af', 'astats=measure_overall=Peak_level+RMS_level:measure_perchannel=none',
    '-f', 'null', '-',
  ]).catch((error: { stderr?: string }) => ({ stderr: error.stderr ?? '' }));

  const peak = /Peak level dB:\s*(-?[\d.]+|-inf)/.exec(stderr ?? '');
  const mean = /RMS level dB:\s*(-?[\d.]+|-inf)/.exec(stderr ?? '');
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  const seconds = Number(stdout.trim());

  return {
    durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
    peakDb: peak?.[1] === '-inf' ? -120 : Number(peak?.[1] ?? -120),
    meanDb: mean?.[1] === '-inf' ? -120 : Number(mean?.[1] ?? -120),
  };
}

/**
 * Проверка одной реплики. Сначала считаются показатели дорожки — они работают без
 * распознавания, — и только потом сверяются слова. Порядок важен: тишину нет смысла
 * распознавать, а её причина видна сразу.
 */
export async function checkSpeech(input: SpeechCheckInput): Promise<SpeechCheckResult> {
  const stats = await audioStats(input.audioFile);
  const base = {
    durationMs: stats.durationMs,
    missingWords: [] as string[],
    loudnessWarning: '',
    transcript: null as SpeechTranscript | null,
  };

  if (stats.durationMs < 200 || stats.meanDb <= -60) {
    return {
      ...base,
      status: 'warning',
      reason: 'В дорожке нет речи: тишина или обрыв.',
    };
  }

  const loudnessWarning = stats.peakDb > -0.5
    ? 'Пики упираются в потолок: возможен перегруз.'
    : '';

  if (!input.transcribe) {
    return {
      ...base,
      status: 'skipped',
      loudnessWarning,
      reason: 'Распознавание недоступно: место придётся послушать самому.',
    };
  }

  let heardText = '';
  let transcript: SpeechTranscript | null = null;

  try {
    const recognized = await input.transcribe(input.audioFile);

    if (typeof recognized === 'string') {
      heardText = recognized;
    } else {
      transcript = recognized;
      heardText = recognized.segments.map((segment) => segment.text).join(' ').trim();
    }
  } catch (error) {
    return {
      ...base,
      status: 'skipped',
      loudnessWarning,
      reason: `Распознавание не отработало: ${error instanceof Error ? error.message : 'причина неизвестна'}.`,
    };
  }

  const expected = normalizeWords(input.expectedText);
  const heard = normalizeWords(heardText);
  const missing = missingFrom(expected, heard);
  const ratio = expected.length > 0 ? missing.length / expected.length : 0;

  if (missing.length > 0 && ratio > MISMATCH_LIMIT) {
    return {
      ...base,
      transcript,
      status: 'warning',
      loudnessWarning,
      missingWords: missing,
      reason: `Расшифровка разошлась с текстом: не слышно ${missing.length} слов(а).`,
    };
  }

  if (missing.length > 0) {
    return {
      ...base,
      transcript,
      status: 'warning',
      loudnessWarning,
      missingWords: missing,
      // Малое расхождение всё равно показывается словами: пропуск короткого слова
      // почти не двигает долю, а смысл меняет.
      reason: 'Расшифровка почти совпала, но отдельные слова не слышны.',
    };
  }

  // Причина — про слова; про громкость говорит своё поле, и склейка двух текстов
  // не должна повторять одно предупреждение дважды.
  return {
    ...base,
    transcript,
    status: loudnessWarning ? 'warning' : 'passed',
    loudnessWarning,
    reason: 'Слова совпали с расшифровкой.',
  };
}
