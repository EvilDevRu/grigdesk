import { buildProgressBar } from './buildState.ts';
import { cliTranslator } from './i18n.ts';
import { terminalLabel, terminalText } from './terminal.ts';
import type { PipelineObserver } from '../tools/releasePipeline.mts';

type Phase = 'snapshot' | 'setup' | 'windows' | 'acceptance' | 'record';

/**
 * Терминал обновляет одну строку, а меню читает ту же строку из stderr через CR.
 * В обычном pipe и CI наблюдатель отсутствует, stdout и stderr сохраняют прежний вывод.
 */
export function createDistributionProgress() {
  const screen = process.env.GRIGDESK_CTL_DIST_PROGRESS === '1';
  const terminal = process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY;

  if (!screen && !terminal) {
    return undefined;
  }

  const live = process.env.TERM !== 'dumb';
  const { t } = cliTranslator();
  const started = Date.now();
  const pending = { stdout: '', stderr: '' };
  let finished = 0;
  let total = 0;
  let label = '';
  let last = '';
  let open = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Процент считает успешные стадии и до записи verified остаётся ниже 100.
   * Ограничение видимой строки защищает от переноса и управляющих символов из журнала.
   */
  function draw(end = false, success = false): void {
    clearTimeout(timer);
    timer = undefined;

    const percent = success ? 100 : total ? Math.min(99, finished * 100 / total) : 0;
    const width = terminal ? Math.max(1, (process.stderr.columns || 80) - 1) : 79;
    const bar = buildProgressBar(percent, Math.min(12, Math.max(3, Math.floor(width / 6))));
    const elapsed = Math.floor((Date.now() - started) / 1000);
    const headline = screen ? `${bar}  ${label}` : `${bar}  ${label} · ${elapsed}s`;
    const content = last ? `${headline}  › ${last}` : headline;
    const line = terminal && !screen
      ? terminalLabel(content, width, success ? 'success' : 'accent')
      : terminalText(content, width);
    const prefix = live ? (screen ? '\r' : '\r\x1b[K') : '';

    open = live && !end;
    process.stderr.write(prefix + line + (open ? '' : '\n'));
  }

  /**
   * Новая стадия появляется сразу, до вывода её команды.
   * Хвост предыдущей стадии не используется в качестве сообщения текущей.
   */
  function start(title: string): void {
    label = title;
    last = '';
    pending.stdout = '';
    pending.stderr = '';
    draw();
  }

  /**
   * Храним последнюю непустую строку, включая неполную строку каждого потока.
   * Частый TAP и npm-вывод не заставляют терминал перерисовываться на каждый chunk.
   */
  const output: PipelineObserver['output'] = (chunk, stream) => {
    if (!chunk) {
      return;
    }

    const lines = (pending[stream] + chunk).split(/[\r\n]+/u);

    pending[stream] = lines.at(-1)!.slice(-4096);
    last = lines.reverse().find((line) => line.trim())?.trim().slice(-4096) ?? last;
    timer ??= setTimeout(draw, 250).unref();
  };

  const close = () => {
    if (open) {
      draw(true);
    }
  };

  return {
    plan: (count: number) => {
      total = count;
    },
    phase: (phase: Phase) => start(t(`distribution.progress.${phase}`)),
    completed: () => {
      finished++;
    },
    /**
     * Каждая копия пишет отдельный полный журнал. Его путь остаётся перед шкалой
     * и доступен при ошибке даже тогда, когда хвост стадии больше ширины терминала.
     */
    observer(logFile: string, scope?: 'server' | 'web' | 'build'): PipelineObserver {
      close();
      process.stderr.write(t('log', { path: logFile }) + '\n');

      return {
        /**
         * Повторяющиеся стадии различаются по копии, в которой выполняются.
         * Для пользовательского рецепта без перевода сохраняется идентификатор стадии.
         */
        start(stage) {
          const key = `distribution.progress.stages.${stage.id}`;
          const translated = t(key);
          const name = translated === key ? stage.id : translated;

          start(scope ? `${t(`distribution.progress.scope.${scope}`)} · ${name}` : name);
        },
        finish(outcome) {
          if (outcome.status === 'success') {
            finished++;
          } else {
            close();
          }
        },
        output: live ? output : undefined,
      };
    },
    success: () => {
      label = t('screens.done');
      draw(true, true);
    },
    close,
  };
}
