// Голос пульта: Telegram-файл → приватный временный каталог → общий SpeechRuntime.
// Временные байты удаляются при любом исходе и никогда не попадают в pult-state.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type Payload = Record<string, unknown>;

// Общий движок распознавания речи: пульт зовёт ровно один его метод и ничего
// не знает ни о модели, ни о её настройках — те приходят снаружи как есть.
interface SpeechRuntimePort {
  transcribe?: (options: {
    filePath: string;
    workDir: string;
    settings: unknown;
    signal: AbortSignal;
  }) => Promise<unknown>;
}

const TRANSCRIBE_TIMEOUT_MS = 120_000;

function transcriptText(result: unknown): string {
  const transcript = (result as { transcript?: { text?: unknown; segments?: unknown } } | null)
    ?.transcript;
  const direct = String(transcript?.text || '').trim();

  if (direct) return direct;

  return (Array.isArray(transcript?.segments) ? transcript.segments as Payload[] : [])
    .map((segment) => String(segment?.text || '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

export async function transcribePultVoice({
  bytes,
  fileName = 'voice.oga',
  speechRuntime,
  settings,
  signal = null,
  timeoutMs = TRANSCRIBE_TIMEOUT_MS,
}: {
  bytes?: Buffer;
  fileName?: string;
  speechRuntime?: SpeechRuntimePort;
  settings?: unknown;
  signal?: AbortSignal | null;
  timeoutMs?: number;
} = {}): Promise<string> {
  if (!speechRuntime?.transcribe) {
    throw Object.assign(new Error('Распознавание речи не настроено.'), { code: 'speech_unavailable' });
  }
  if (!Buffer.isBuffer(bytes) || !bytes.length) {
    throw Object.assign(new Error('Голосовое сообщение не скачалось.'), { code: 'voice_empty' });
  }
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-pult-voice-'));
  const safeExt = path.extname(String(fileName || '')).replace(/[^.a-z0-9]/giu, '').slice(0, 10) || '.oga';
  const filePath = path.join(workDir, `voice${safeExt}`);
  const abort = new AbortController();
  const forwardAbort = () => abort.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener?.('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => abort.abort(new Error('speech_timeout')), timeoutMs);

  (timer as { unref?: () => void }).unref?.();
  try {
    await writeFile(filePath, bytes, { mode: 0o600 });
    const result = await speechRuntime.transcribe?.({
      filePath,
      workDir,
      settings,
      signal: abort.signal,
    });
    return transcriptText(result);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', forwardAbort);
    await rm(workDir, { recursive: true, force: true });
  }
}

export default transcribePultVoice;
