import type {
  PluginInstallChanges,
  PluginInstalledVersion,
  PluginVersionRef,
} from '../../../../shared/plugins/pluginInstallContracts.ts';
import { GitPluginSource } from './gitSource.ts';
import type { PluginCommandRunner } from './runCommand.ts';

import type { PluginWorkspaceBudget } from './runCommand.ts';

import { installError } from './errors.ts';

export interface PluginInstalledState {
  sha: string | null;
  modified: boolean;
}

export interface PluginFetchRequest {
  url: string;
  target: PluginVersionRef;
  destination: string;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
  workspaceBudget?: PluginWorkspaceBudget;
}

export type PluginSourceChanges = Omit<PluginInstallChanges, 'sensitive'>;

export interface PluginSource {
  readonly kind: string;
  normalizeUrl(raw: unknown): string;
  listVersions(url: string, signal?: AbortSignal): Promise<PluginVersionRef[]>;
  fetch(request: PluginFetchRequest): Promise<void>;
  changes(directory: string, fromSha: string, toSha: string): Promise<PluginSourceChanges | null>;
  inspectInstalled(directory: string, expected: PluginInstalledVersion): Promise<PluginInstalledState>;
}

/**
 * Реестр отделяет выбор стратегии от самого Git transport.
 * Первый сценарий требует непустой список с уникальным kind.
 */
export class PluginSourceRegistry {
  private readonly sources: readonly PluginSource[];

  /**
   * Порядок стратегий сохраняется: специализированная может стоять перед Git.
   * Повтор kind запрещён, чтобы persisted source имел однозначного владельца.
   */
  constructor(sources: readonly PluginSource[]) {
    if (sources.length === 0 || new Set(sources.map((source) => source.kind)).size !== sources.length) {
      throw new TypeError('Нужны непустой список и уникальные виды источников');
    }

    this.sources = [...sources];
  }

  /**
   * Поиск persisted source выполняется по kind, без знания хостинга в caller.
   * Следующий тест требует отказа при неизвестной стратегии.
   */
  get(kind: string): PluginSource {
    const source = this.sources.find((entry) => entry.kind === kind);

    if (!source) {
      throw installError('source_kind_unknown');
    }

    return source;
  }

  /**
   * Адрес выбирает первую подходящую стратегию в заданном порядке.
   * Неподдержанный URL сохраняет безопасный отказ источника.
   */
  forUrl(raw: unknown): { source: PluginSource; url: string } {
    let last: unknown = installError('source_url_invalid');

    for (const source of this.sources) {
      try {
        return { source, url: source.normalizeUrl(raw) };
      } catch (error) {
        last = error;
      }
    }

    throw last;
  }
}

/**
 * Factory получает runner сборки, чтобы все команды могли иметь durable ownership.
 * Первая версия реестра содержит только Git transport.
 */
export function createDefaultPluginSources(
  options: { run?: PluginCommandRunner } = {},
): PluginSourceRegistry {
  return new PluginSourceRegistry([new GitPluginSource({ run: options.run })]);
}
