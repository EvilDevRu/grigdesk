import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { HELP_MAX_BYTES, helpInvalid, parseHelpInput } from '../../../../shared/help/helpContracts.ts';
import type { HelpBundle, HelpLocale } from '../../../../shared/help/helpContracts.ts';
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
  read?: (locale: HelpLocale) => Promise<HelpBundle>;
}) {
  const pending = new Map<HelpLocale, Promise<HelpBundle>>();

  /**
   * Читает только источник выбранного вида runtime и проверяет полный корпус.
   * Подмена injected-reader разрешена лишь модульным fixture, не пользовательскому запросу.
   */
  async function read(locale: HelpLocale): Promise<HelpBundle> {
    if (options.read) {
      return verifyHelpBundle(await options.read(locale));
    }
    if (options.kind === 'source') {
      const version = (await readFile(path.join(options.root, 'VERSION'), 'utf8')).trim();

      return compileHelpSources(options.root, {
        version, commit: 'source'
      }, locale);
    }

    const file = locale === 'en' ? 'help.en.json' : 'help.json';
    const text = await readContainedText(options.root, `server/help/${file}`, HELP_MAX_BYTES);

    if (text === null && locale === 'en') {
      await lstat(path.join(options.root, 'server/help', file)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          throw new Error('help_locale_unavailable');
        }

        helpInvalid();
      });
    }

    if (!text || Buffer.byteLength(text) > HELP_MAX_BYTES) {
      helpInvalid();
    }

    return verifyHelpBundle(JSON.parse(text));
  }

  /**
   * Совмещает параллельное чтение неизменяемого пакета одного поколения.
   * Отказ снимает кеш Promise, поэтому следующий запрос пробует чтение заново.
   */
  async function bundle(locale: HelpLocale = 'ru'): Promise<HelpBundle> {
    if (locale !== 'ru' && locale !== 'en') {
      throw new Error('help_input_invalid');
    }

    const load = async () => {
      const result = await read(locale);

      if (result.locale !== locale) {
        helpInvalid();
      }

      return result;
    };

    if (options.kind === 'source') {
      return load();
    }

    let result = pending.get(locale);

    if (!result) {
      result = load().catch((error: unknown) => {
        pending.delete(locale);

        throw error;
      });
      pending.set(locale, result);
    }

    return result;
  }

  /**
   * Возвращает безопасный результат общего запроса без раскрытия локальных путей.
   * Недоступность корпуса отделена от неверных параметров пользователя.
   */
  async function invoke(input: unknown): Promise<unknown> {
    try {
      const parsed = parseHelpInput(input);

      return queryHelp(await bundle(parsed.locale ?? 'ru'), parsed);
    }
    catch (error) {
      if (error instanceof Error && error.message === 'help_locale_unavailable') {
        const parsed = parseHelpInput(input);

        return {
          ok: false,
          error: 'help_locale_unavailable',
          locale: parsed.locale ?? 'ru'
        };
      }

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
