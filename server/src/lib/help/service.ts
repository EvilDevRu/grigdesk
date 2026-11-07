import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { HELP_MAX_BYTES, helpInvalid } from '../../../../shared/help/helpContracts.ts';
import type { HelpBundle } from '../../../../shared/help/helpContracts.ts';
import { queryHelp } from '../../../../shared/help/helpQuery.ts';
import { compileHelpSources, verifyHelpBundle } from '../../../../shared/node/helpSources.ts';
import { readContainedText } from '../../../../shared/node/readContainedText.ts';
/**
 * Source читает текущий guide, packaged читает только ресурс собственного поколения.
 * Ошибка загрузки не кешируется навсегда и не подменяется руководством другой версии.
 */
export function createHelpService(options: {
  root: string;
  kind: 'source' | 'packaged';
  read?: () => Promise<HelpBundle>;
}) {
  let pending: Promise<HelpBundle> | null = null;

  /**
   * Читает только источник выбранного вида runtime и проверяет полный корпус.
   * Подмена injected-reader разрешена лишь модульным fixture, не пользовательскому запросу.
   */
  async function read(): Promise<HelpBundle> {
    if (options.read) {
      return verifyHelpBundle(await options.read());
    }
    if (options.kind === 'source') {
      const version = (await readFile(path.join(options.root, 'VERSION'), 'utf8')).trim();

      return compileHelpSources(options.root, {
        version, commit: 'source'
      });
    }

    const text = await readContainedText(options.root, 'server/help/help.json', HELP_MAX_BYTES);

    if (!text || Buffer.byteLength(text) > HELP_MAX_BYTES) {
      helpInvalid();
    }

    return verifyHelpBundle(JSON.parse(text));
  }

  /**
   * Совмещает параллельное чтение неизменяемого пакета одного поколения.
   * Отказ снимает кеш Promise, поэтому следующий запрос пробует чтение заново.
   */
  async function bundle(): Promise<HelpBundle> {
    if (options.kind === 'source') {
      return read();
    }
    if (!pending) {
      pending = read().catch((error: unknown) => {
        pending = null;

        throw error;
      });
    }

    return pending;
  }

  /**
   * Возвращает безопасный результат общего запроса без раскрытия локальных путей.
   * Недоступность корпуса отделена от неверных параметров пользователя.
   */
  async function invoke(input: unknown): Promise<unknown> {
    try {
      return queryHelp(await bundle(), input);
    }
    catch (error) {
      return {
        ok: false, error: error instanceof Error && error.message === 'help_input_invalid'
          ? 'help_input_invalid' : 'help_unavailable'
      };
    }
  }

  return {
    bundle, invoke
  };
}

export type HelpService = ReturnType<typeof createHelpService>;
