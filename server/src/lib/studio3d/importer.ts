// Импорт читает только task.json и разрешённые соседние ассеты. Накопленный индекс
// отделён от моделей: удаление проекции не стирает расходы и запрещает auto resurrection.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { parseStudio3d } from '../../../../shared/studio3d/studio3dContracts.ts';
import { operationSpec, refineKind } from '../../../../shared/studio3d/studio3dOperations.ts';
import type { VersionKind, UnitForms } from '../../../../shared/studio3d/studio3dOperations.ts';
import { withPathLock } from '../pathLock.ts';
import { inspectModel, inspectImage } from './assetFormats.ts';
import { downloadToFile } from './download.ts';
import type { DownloadOptions } from './download.ts';
import type { DiskModel, DiskVersion, StudioLibrary } from './library.ts';
import type { StudioIntents } from './intents.ts';
import type { AccountSnapshot, RecordedTask, RemoteTask, Studio3dProvider, UsageRecord } from './provider.ts';
import { spendingFor } from './search.ts';
import {
  ensureDirectory,
  isExternalName,
  isSafeName,
  pinDirectory,
  readJson,
  verifiedHash
} from './safePath.ts';

const EXCLUDED = new Set([
  'node_modules', '.git', 'dist', 'build', 'venv', '.venv', '__pycache__', '.cache',
  'chats', 'telegram', 'github', 'credentials', 'credential', '.codex', '.claude',
  '.agents', '.aws', '.ssh', '.tripo', '.state', 'conversations', 'sessions',
]);
const MODELS = new Set(['.glb', '.fbx', '.obj', '.stl', '.splat']);
const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIEWS = ['front', 'left', 'back', 'right'];
const TASK_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

interface Asset {
  root: string;
  source: string;
  name: string;
  role: string;
}

interface Observation {
  key: string;
  provider: string;
  accountKey: string | null;
  nativeVerified: boolean;
  unit: UnitForms | null;
  record: RecordedTask;
  usage: UsageRecord | null;
  name: string;
  assets: Asset[];
  model: DiskModel | null;
  version: DiskVersion | null;
  modelId: string | null;
  versionId: string | null;
  tombstone: boolean;
  label: string | null;
  importedPreview?: string | null;
  obsolete: {
    modelId: string;
    versionId: string;
    model?: DiskModel | null;
    preview?: string | null
  }[];
}

interface Index {
  schema: 1;
  libraryId: string;
  observations: Observation[];
  historyPartial: boolean;
  historyError: string | null;
  diskScanned?: boolean;
}

export interface ImporterOptions {
  library: StudioLibrary;
  providers: Studio3dProvider[];
  roots: () => string[] | Promise<string[]>;
  intents?: StudioIntents;
  enabled?: () => boolean;
  download?: (options: DownloadOptions) => ReturnType<typeof downloadToFile>;
  now?: () => number;
  broadcast?: (name: string, payload: Record<string, unknown>) => void;
  observeUsage?: (provider: string, captured: AccountSnapshot, usages: UsageRecord[]) => Promise<void>;
  limits?: {
    depth?: number;
    entries?: number;
    deadlineMs?: number
  };
}

/**
 * Общие имена дополняются родителем; случайный суффикс CLI не становится названием.
 * Имя не содержит полного локального пути и не переносится в публичный provenance.
 */
export function importName(directory: string): string {
  const name = path.basename(directory).replace(/-[a-f0-9]{8}$/i, '');
  const generic = /^(model|tripo|out|high|low|rig|tripo-out|out-.+)$/i.test(name);
  let parent = path.dirname(directory);

  while (/^(tripo|out|tripo-out|out-.+)$/i.test(path.basename(parent))
    && path.dirname(parent) !== parent) {
    parent = path.dirname(parent);
  }

  return generic ? `${path.basename(parent)} · ${name}` : name;
}

/**
 * Factory не читает состояние и не обращается к сети. Все входные корни предоставлены
 * сервером; enable запускает отдельный ограниченный lifecycle.
 */
export function createImporter(options: ImporterOptions) {
  return new Importer(options);
}

class Importer {
  private readonly options: ImporterOptions;
  private readonly providers: Map<string, Studio3dProvider>;
  private index: Index | null = null;
  private stopped = false;
  private readonly abort = new AbortController();

  constructor(options: ImporterOptions) {
    this.options = options;
    this.providers = new Map(options.providers.map((provider) => [provider.id, provider]));
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private enabled(): boolean {
    return !this.stopped && (this.options.enabled?.() ?? true);
  }

  private key(provider: string, accountKey: string | null, taskId: string): string {
    return JSON.stringify([provider, accountKey, taskId]);
  }

  /**
   * Единый lock покрывает scan, history и ручной import, включая durable index.
   * Одновременный источник дополняет одну задачу, не выделяет вторую модель.
   */
  private locked<T>(action: () => Promise<T>): Promise<T> {
    return withPathLock(`${this.options.library.dir}:importer`, async () => {
      if (!this.enabled()) {
        throw new Error('plugin_disabled');
      }

      await this.load();

      return action();
    });
  }

  /**
   * Индекс имеет лимит и закрытый корневой контракт; записи проверяются заново.
   * Диск не может добавить provider, task ID или файловый root вне текущего scope.
   */
  private async load(): Promise<void> {
    if (this.index) {
      return;
    }

    const library = this.options.library;
    const raw = await readJson(library.dir, path.join(library.dir, '.jobs', 'imports-index.json'),
      16 * 1024 * 1024)
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }

        throw error;
      });

    if (raw === null) {
      this.index = {
        schema: 1,
        libraryId: library.libraryId,
        observations: [],
        historyPartial: true,
        historyError: null,
      };

      return;
    }

    const data = raw as Index;

    if (!data || data.schema !== 1 || data.libraryId !== library.libraryId
      || Object.keys(data).some((key) => !['schema', 'libraryId', 'observations',
        'historyPartial', 'historyError', 'diskScanned'].includes(key))
      || !Array.isArray(data.observations) || data.observations.length > 10_000
      || typeof data.historyPartial !== 'boolean'
      || (data.historyError !== null && typeof data.historyError !== 'string')
      || (data.diskScanned !== undefined && typeof data.diskScanned !== 'boolean')) {
      throw new Error('invalid_import_index');
    }

    const keys = new Set<string>();

    for (const item of data.observations) {
      if (!this.providers.has(item.provider) || !TASK_ID.test(item.record?.taskId)
        || item.key !== this.key(item.provider, item.accountKey, item.record.taskId)
        || keys.has(item.key) || !Array.isArray(item.assets) || item.assets.length > 128
        || !Array.isArray(item.obsolete) || item.obsolete.length > 128
        || typeof item.tombstone !== 'boolean' || typeof item.nativeVerified !== 'boolean'
        || !['raw', 'cli'].includes(item.record.source)) {
        throw new Error('invalid_import_index');
      }

      parseStudio3d.values(item.record.params);
      parseStudio3d.unit(item.unit);

      for (const asset of item.assets) {
        if (!isSafeName(asset.name) || typeof asset.root !== 'string'
          || typeof asset.source !== 'string' || path.dirname(asset.source) === asset.source
          || !['model', 'image', 'preview', ...VIEWS].includes(asset.role)) {
          throw new Error('invalid_import_index');
        }
      }

      keys.add(item.key);
    }

    this.index = data;
  }

  /**
   * Публикуется весь накопленный снимок с fsync; короткий API ответ не удаляет историю.
   * Сбой записи виден caller-у и не объявляет импорт завершённым.
   */
  private async persist(): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(this.index)) > 16 * 1024 * 1024) {
      throw new Error('import_index_limit');
    }

    await this.options.library.persist(path.join(this.options.library.dir, '.jobs', 'imports-index.json'),
      this.index);
  }

  /**
   * Realpath только у доверенного корня; вложенные ссылки обход не разыменовывает.
   * Повторные корни и сама библиотека исключаются до чтения task.json.
   */
  private async roots(): Promise<string[]> {
    const result = new Set<string>();

    for (const root of await this.options.roots()) {
      const canonical = await fs.realpath(root).catch(() => null);

      if (canonical && canonical !== this.options.library.dir) {
        result.add(canonical);
      }
    }

    return [...result];
  }

  /**
   * Файлы выбираются по роли и расширению, не по URL или произвольному CLI path.
   * Только обычные соседние файлы с безопасными именами могут стать copy source.
   */
  private async assets(root: string, directory: string, record: RecordedTask): Promise<Asset[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && isExternalName(entry.name))
      .map((entry) => entry.name).sort();
    const operation = this.providers.get(this.findProvider(record))?.taskOperation?.(record.type);
    const kind = operation ? operationSpec(operation)?.output : 'model';
    const result: Asset[] = [];

    /**
     * Исходник сохраняет внешнее имя только в пути чтения из доверенного корня.
     * Публикуемое имя приводится к латинице по роли и расширению контейнера.
     */
    const add = (name: string | undefined, role: string) => {
      if (name && !result.some((asset) => asset.name === name)) {
        result.push({
          root,
          source: path.join(directory, name),
          name: isSafeName(name) ? name : `${role}${path.extname(name).toLowerCase()}`,
          role
        });
      }
    };

    if (kind === 'views') {
      for (const view of VIEWS) {
        add(files.find((name) => name.startsWith(`${view}_view.`)
          && IMAGES.has(path.extname(name).toLowerCase())), view);
      }
    } else if (kind === 'image') {
      add(files.find((name) => IMAGES.has(path.extname(name).toLowerCase())), 'image');
    } else {
      const model = files.find((name) => /^(model|pbr_model)\./.test(name)
        && MODELS.has(path.extname(name).toLowerCase()))
        ?? files.find((name) => MODELS.has(path.extname(name).toLowerCase()));

      add(model, 'model');
    }

    add(files.find((name) => /^(preview|rendered_image)\./.test(name)
      && IMAGES.has(path.extname(name).toLowerCase()))
      ?? files.find((name) => IMAGES.has(path.extname(name).toLowerCase())), 'preview');

    return result;
  }

  private findProvider(record: RecordedTask): string {
    return [...this.providers.values()].find((provider) => provider.taskOperation?.(record.type))?.id ?? '';
  }

  /**
   * Disk provenance без аккаунта остаётся непроверенным даже при текущем ключе.
   * Совпавшее наблюдение истории дополняет расход, но не предоставляет native права.
   */
  private observe(provider: Studio3dProvider, record: RecordedTask, accountKey: string | null,
    name: string, assets: Asset[]): Observation {
    const list = this.index!.observations;
    let item = list.find((entry) => entry.provider === provider.id && entry.record.taskId === record.taskId
      && (entry.accountKey === accountKey || entry.accountKey === null || accountKey === null));

    if (!item) {
      if (list.length >= 10_000) {
        throw new Error('import_index_limit');
      }

      item = {
        key: this.key(provider.id, accountKey, record.taskId),
        provider: provider.id,
        accountKey,
        nativeVerified: accountKey !== null,
        unit: provider.unit,
        record,
        usage: null,
        name,
        assets: [],
        model: null,
        version: null,
        modelId: null,
        versionId: null,
        tombstone: false,
        label: null,
        obsolete: [],
      };
      list.push(item);
    } else if (record.source === 'cli' || assets.length > 0 || item.record.status === 'unknown') {
      item.record = record;
    }

    if (assets.length > 0) {
      const existingDepth = Math.max(0, ...item.assets.map((asset) => asset.source.split(path.sep).length));
      const depth = Math.max(...assets.map((asset) => asset.source.split(path.sep).length));

      if (depth > existingDepth) {
        item.name = name;
      }

      for (const asset of assets) {
        if (!item.assets.some((current) => current.source === asset.source)) {
          item.assets.push(asset);
        }
      }
    }

    return item;
  }

  /**
   * Скан имеет общий deadline и отдельный бюджет каждого корня. Он читает только
   * task.json ≤1 МиБ, собирает все записи до построения родства, причины partial явные.
   */
  async scan({ automatic = false }: { automatic?: boolean } = {}) {
    return this.locked(async () => {
      if (automatic && this.index!.diskScanned) {
        return parseStudio3d.scan({
          libraryId: this.options.library.libraryId,
          found: 0,
          imported: 0,
          skipped: 0,
          partial: false,
          reasons: []
        });
      }

      const roots = await this.roots();
      const deadline = this.now() + Math.min(20_000, this.options.limits?.deadlineMs ?? 20_000);
      const wallDeadline = Date.now() + Math.min(20_000, this.options.limits?.deadlineMs ?? 20_000);
      const reasons: string[] = [];
      let found = 0;
      let skipped = 0;
      const selected = new Set<string>();

      for (const root of roots) {
        let count = 0;
        const stack = [{ directory: root, depth: 0 }];

        while (stack.length > 0) {
          if (this.now() >= deadline || Date.now() >= wallDeadline || !this.enabled()) {
            reasons.push('Скан остановлен по сроку или выключению плагина.');
            break;
          }

          const current = stack.pop()!;
          const entries = await fs.readdir(current.directory, { withFileTypes: true }).catch(() => null);

          if (!entries) {
            reasons.push('Часть папок недоступна.');
            continue;
          }

          for (const entry of entries) {
            count += 1;

            if (count > Math.min(50_000, this.options.limits?.entries ?? 50_000)) {
              reasons.push('Достигнут предел записей корня.');
              stack.length = 0;
              break;
            }

            const file = path.join(current.directory, entry.name);

            if (entry.isDirectory() && !EXCLUDED.has(entry.name) && file !== this.options.library.dir
              && !(entry.name === 'local' && path.basename(current.directory) === 'docs')) {
              if (current.depth < Math.min(8, this.options.limits?.depth ?? 8)) {
                stack.push({ directory: file, depth: current.depth + 1 });
              } else {
                reasons.push('Достигнут предел глубины.');
              }
            }

            if (!entry.isFile() || entry.name !== 'task.json') {
              continue;
            }

            try {
              const json = await readJson(root, file, 1024 * 1024);
              let recognized = false;

              for (const provider of this.providers.values()) {
                const record = provider.recognizeRecord?.(json);

                if (!record) {
                  continue;
                }

                const item = this.observe(provider, record, null, importName(current.directory),
                  await this.assets(root, current.directory, record));

                selected.add(item.key);
                found += 1;
                recognized = true;
                break;
              }

              if (!recognized) {
                skipped += 1;
              }
            } catch {
              skipped += 1;
              reasons.push('Запись или ассет не прошли безопасное чтение.');
            }
          }
        }
      }

      await this.persist();

      const imported = await this.importOrdered(selected, 'import', false, reasons);

      skipped += this.index!.observations.filter((item) => selected.has(item.key)
        && this.providers.get(item.provider)?.taskOperation?.(item.record.type) === 'rig-check'
        && !this.parent(item)?.versionId).length;

      await this.cleanObsolete(reasons);
      this.index!.diskScanned = true;
      await this.persist();

      return parseStudio3d.scan({
        libraryId: this.options.library.libraryId,
        found,
        imported,
        skipped,
        partial: reasons.length > 0,
        reasons: [...new Set(reasons)],
      });
    });
  }

  /**
   * Родитель обрабатывается первым независимо от даты. Цикл и отсутствующий parent
   * не замалчиваются; поздний parent переносит одну задачу, не создаёт второй identity.
   */
  private async importOrdered(selected: Set<string>, origin: 'import' | 'agent', explicit: boolean,
    reasons: string[]): Promise<number> {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    let imported = 0;

    /**
     * Каждая запись посещается один раз, parent завершает materialize первым.
     * Цикл оставляет предупреждение и не создаёт циклическую файловую проекцию.
     */
    const visit = async (item: Observation): Promise<void> => {
      if (visited.has(item.key)) {
        return;
      }

      if (visiting.has(item.key)) {
        reasons.push('Цикл происхождения задачи: связь не восстановлена.');
        
        return;
      }

      visiting.add(item.key);

      const parent = this.parent(item);

      if (parent) {
        await visit(parent);
      } else if (item.record.inputTaskId) {
        reasons.push('Родитель ещё не найден; задача сохранена отдельно.');
      }

      visiting.delete(item.key);
      visited.add(item.key);

      try {
        if (await this.importOne(item, origin, explicit, null, parent)) {
          imported += 1;
        }
      } catch {
        reasons.push('Одна задача не импортирована; остальные обработаны.');
      }
    };

    for (const item of this.index!.observations.filter((entry) => selected.has(entry.key))) {
      await visit(item);
    }

    return imported;
  }

  private parent(item: Observation): Observation | null {
    return this.index!.observations.find((entry) => entry.provider === item.provider
      && entry.record.taskId === item.record.inputTaskId
      && (entry.accountKey === item.accountKey || entry.accountKey === null ||
        item.accountKey === null)) ?? null;
  }

  /**
   * Tombstone выставляется только после известной опубликованной проекции.
   * Незавершённый planned template после crash materialize-ится с прежними ID.
   */
  private async existing(item: Observation) {
    if (!item.modelId) {
      return null;
    }

    const entry = await this.options.library.readModel(item.modelId).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }

      throw error;
    });

    if (!entry || !entry.versions.some((version) => version.id === item.versionId)) {
      item.tombstone = true;
    }

    return entry;
  }

  /**
   * Сначала durable план, затем materialize и независимые copy. Версия ready
   * требует model/image либо фронт и второй вид; preview не заменяет результат.
   */
  private async importOne(item: Observation, origin: 'import' | 'agent', explicit: boolean,
    remote: RemoteTask | null, parent = this.parent(item), captured?: AccountSnapshot): Promise<boolean> {
    const library = this.options.library;
    const provider = this.providers.get(item.provider)!;
    const operation = provider.taskOperation?.(item.record.type);

    if (!operation) {
      return false;
    }

    let entry = await this.existing(item);

    if (item.tombstone && !explicit) {
      return false;
    }

    if (operation === 'rig-check') {
      const target = parent && await this.existing(parent);

      if (target && parent!.versionId && item.record.rigResult) {
        await library.updateVersion(target.model.id, parent!.versionId, {
          rigCheck: {
            status: 'ready',
            riggable: item.record.rigResult.riggable,
            rigType: item.record.rigResult.rigType,
            at: item.record.completedAt ?? new Date(this.now()).toISOString(),
            jobId: item.record.taskId,
            childId: 'import-check',
          }
        });
      }

      return false;
    }

    const parentEntry = parent && !parent.tombstone ? await this.existing(parent) : null;
    const parentVersionId = parentEntry ? parent!.versionId : null;
    const relocating = entry && parentEntry && entry.model.id !== parentEntry.model.id;
    let created = !entry || Boolean(relocating);

    if (item.tombstone && explicit) {
      item.model = null;
      item.version = null;
      item.modelId = null;
      item.versionId = null;
      item.tombstone = false;
      entry = null;
      created = true;
    }

    if (relocating) {
      item.obsolete.push({
        modelId: item.modelId!,
        versionId: item.versionId!,
        model: item.model,
        preview: item.importedPreview ?? null
      });
      item.model = null;
      item.version = null;
      item.modelId = null;
      item.versionId = null;
      entry = null;
    }

    if (!item.version) {
      const spec = operationSpec(operation)!;
      const output = spec.output;
      const kind = output === 'same' || output === 'check' ? 'model' : output;
      const model = parentEntry?.model ?? await library.planModel({ name: item.name, origin });
      const version = await library.planVersion(parentEntry ? model.id : model, {
        kind,
        operation,
        parent: parentVersionId,
        provider: provider.id,
        label: spec.label,
        status: 'remote',
        task: {
          provider: provider.id,
          id: item.record.taskId,
          type: item.record.type
        },
        params: item.record.params,
        origin,
        accountKey: item.nativeVerified ? item.accountKey : null,
        createdAt: item.record.createdAt ?? new Date(this.now()).toISOString(),
        cost: {
          estimated: null,
          actual: item.usage?.credits ?? item.record.credits,
          free: false,
          unit: item.unit,
          state: (item.usage?.credits ?? item.record.credits) === null ? 'unknown' : 'charged',
        },
      });

      version.createdAt = item.record.createdAt ?? version.createdAt;

      item.model = model;
      item.version = version;
      await this.persist();
    }

    if (!entry) {
      await library.materializeModel(item.model!);
      await library.materializeVersion(item.model!.id, item.version);

      item.modelId = item.model!.id;
      item.versionId = item.version.id;
      await this.persist();
    }

    let version = (await library.readModel(item.modelId!)).versions.find((v) => v.id === item.versionId)!;

    if (parentVersionId && parentEntry?.model.id === item.modelId && version.parent !== parentVersionId) {
      version = await library.updateVersion(item.modelId!, version.id, { parent: parentVersionId });
    }

    const roots = await this.roots();
    const retained: Asset[] = [];
    const releases: (() => void)[] = [];

    try {
      for (const old of item.obsolete) {
        const previous = await library.readModel(old.modelId).catch(() => null);
        const source = previous?.versions.find((candidate) => candidate.id === old.versionId);

        if (!source) {
          continue;
        }

        releases.push(library.leaseVersion(old.modelId, old.versionId, `import-${version.id}`));

        for (const file of source.files) {
          const opened = await library.openVersionFile(old.modelId, old.versionId, file.name);

          await opened.handle.close();
          retained.push({
            root: library.dir,
            source: await library.filePath(old.modelId, old.versionId, file.name),
            name: file.name,
            role: file.role,
          });
        }
      }

    for (const asset of [...retained, ...item.assets]) {
      if ((!retained.includes(asset) && !roots.includes(asset.root))
        || version.files.some((file) => file.role === asset.role)) {
        continue;
      }

      try {
        await library.copyIn(item.modelId!, version.id, {
          sourceRoot: asset.root,
          source: asset.source,
          name: asset.name,
          role: asset.role,
          maxBytes: 150 * 1024 * 1024,
        }).catch(async (error) => {
          if ((error as { code?: string }).code !== 'exists') {
            throw error;
          }

          const source = await verifiedHash(asset.root, asset.source);

          await library.adoptVersionFile(item.modelId!, version.id, asset.name, source.sha256,
            { role: asset.role });
        });
        version = (await library.readModel(item.modelId!)).versions.find((v) => v.id === version.id)!;
      } catch {
        item.label = 'Один из исходных файлов изменён или недоступен.';
      }
    }

    } finally {
      for (const release of releases) {
        release();
      }
    }

    if (!this.complete(version) && remote?.state === 'success') {
      await this.download(item, remote, captured);
      version = (await library.readModel(item.modelId!)).versions.find((v) => v.id === version.id)!;
    }

    if (this.complete(version)) {
      const main = version.files.find((file) => ['model', 'image', 'front'].includes(file.role))!;
      let stats = null;

      for (const file of version.files.filter((file) =>
        ['model', 'image', ...VIEWS].includes(file.role))) {
        const source = await library.filePath(item.modelId!, version.id, file.name);

        if (file.role === 'model') {
          const inspected = await inspectModel(library.dir, source, this.abort.signal);

          if (file.id === main.id) {
            stats = inspected;
          }
        } else {
          await inspectImage(library.dir, source, undefined, this.abort.signal);
        }
      }
      
      const kind = stats ? refineKind(version.kind, stats) : version.kind;
      const views = VIEWS.filter((view) => version.files.some((file) => file.role === view));

      version = await library.updateVersion(item.modelId!, version.id, {
        status: 'ready',
        progress: 100,
        stats,
        kind,
        mainFileId: main.id,
        views: views as DiskVersion['views'],
        waitReason: null,
        error: null,
      });

      if (!(await library.readModel(item.modelId!)).model.mainVersion) {
        await library.updateModel(item.modelId!, { mainVersion: version.id });
      }
    } else {
      await library.updateVersion(item.modelId!, version.id, {
        status: 'remote',
        waitReason: 'Обязательные файлы результата ещё не найдены.',
      });
    }

    if (item.importedPreview === undefined) {
      item.importedPreview = version.files.find((file) => file.role === 'preview')?.sha256 ?? null;
    }

    this.options.broadcast?.('studio-changed', {
      libraryId: library.libraryId,
      modelId: item.modelId,
      versionId: item.versionId,
      status: version.status,
      at: new Date(this.now()).toISOString(),
    });

    return created;
  }

  private complete(version: DiskVersion): boolean {
    if (version.kind === 'views') {
      return version.files.some((file) => file.role === 'front')
        && version.files.filter((file) => VIEWS.includes(file.role)).length >= 2;
    }

    return version.files.some((file) => file.role === (version.kind === 'image' ? 'image' : 'model'));
  }

  /**
   * Remote download использует тот же инъецированный bounded transport, что worker.
   * Директория закреплена fd, expiry URL обновляет только бесплатный poll того же task.
   */
  private async download(item: Observation, remote: RemoteTask,
    verifiedAccount?: AccountSnapshot): Promise<void> {
    const library = this.options.library;
    const provider = this.providers.get(item.provider)!;
    const captured = verifiedAccount ?? provider.snapshot?.();

    if (!captured || (!verifiedAccount && captured.accountKey !== item.accountKey)
      || !provider.isCurrent?.(captured)) {
      throw new Error('account_changed');
    }

    const directory = path.join(library.dir, '.jobs', 'imports', item.record.taskId);

    await ensureDirectory(library.dir, directory);

    const pinned = await pinDirectory(library.dir, directory);

    try {
      for (const output of remote.outputs) {
        if (!this.enabled() || !provider.isCurrent?.(captured)) {
          throw new Error('account_changed');
        }

        await pinned.verify();

        const version = (await library.readModel(item.modelId!)).versions
          .find((entry) => entry.id === item.versionId)!;
        const registered = version.files.find((file) => file.id === output.id
          || (file.name === output.name && file.role === output.role));

        if (registered) {
          const existing = await library.openVersionFile(item.modelId!, item.versionId!, registered.name);
          
          await existing.handle.close();
          continue;
        }

        const target = pinned.child(output.name);

        await (this.options.download ?? downloadToFile)({
          url: output.url,
          dest: target,
          signal: this.abort.signal,
          refresh: async () => {
            const result = await provider.poll!([remote.id], captured);
            const refreshed = result.tasks.find((task) => task.id === remote.id);
            const url = refreshed?.outputs.find((asset) => asset.id === output.id)?.url;

            if (!provider.isCurrent?.(captured) || !url) {
              throw new Error('account_changed');
            }

            return url;
          },
        });
        await pinned.verify();

        let name = output.name;

        if (!['model', 'base-model', 'file'].includes(output.role)) {
          const image = await inspectImage(library.dir, path.join(directory, output.name),
            undefined, this.abort.signal);

          name = path.basename(output.name, path.extname(output.name)) + image.extension;
        }

        await library.copyIn(item.modelId!, item.versionId!, {
          sourceRoot: library.dir,
          source: path.join(directory, output.name),
          name,
          role: output.role,
          id: output.id,
        }).catch(async (error) => {
          if ((error as { code?: string }).code !== 'exists') {
            throw error;
          }
          
          const downloaded = await verifiedHash(library.dir, path.join(directory, output.name));
          
          await library.adoptVersionFile(item.modelId!, item.versionId!, name, downloaded.sha256,
            { role: output.role, id: output.id });
        });
      }
    } finally {
      await pinned.handle.close();
    }

    const parent = await pinDirectory(library.dir, path.dirname(directory));

    try {
      await parent.verify();
      await fs.rm(parent.child(item.record.taskId), { recursive: true, force: true });
    } finally {
      await parent.close();
    }
  }

  /**
   * После переноса потомков удаляются старые импортные проекции. Неперемещённые
   * пользовательские дети удерживают прежнюю версию и явное предупреждение.
   */
  private async cleanObsolete(reasons: string[]): Promise<void> {
    const library = this.options.library;

    for (const item of this.index!.observations) {
      const current = item.modelId ? await library.readModel(item.modelId).catch(() => null) : null;
      const replacement = current?.versions.find((version) => version.id === item.versionId);

      if (replacement?.status !== 'ready') {
        if (item.obsolete.length) {
          reasons.push('Прежняя проекция сохранена до проверки новой копии.');
        }

        continue;
      }

      const retained: Observation['obsolete'] = [];

      for (const old of item.obsolete.slice().reverse()) {
        try {
          const entry = await library.readModel(old.modelId);

          const fields = ['name', 'notes', 'tags', 'category', 'project'] as const;
          const edited = !old.model || fields.some((field) =>
            !isDeepStrictEqual(entry.model[field], old.model![field]))
            || entry.versions.some((version) => version.savedTo.length)
            || (entry.versions.find((version) => version.id === old.versionId)
              ?.files.find((file) => file.role === 'preview')?.sha256 ?? null) !== (old.preview ?? null);

          if (edited) {
            retained.push(old);
            reasons.push('Прежняя модель сохранена: в ней есть правки человека или превью.');

            continue;
          }

          if (entry.versions.length === 1) {
            await library.deleteModel(old.modelId);
          } else {
            await library.deleteVersion(old.modelId, old.versionId);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            retained.push(old);
            reasons.push('Старую проекцию удерживают её потомки или активное действие.');
          }
        }
      }

      item.obsolete = retained;
    }
  }

  /**
   * История накапливается по provider/account/task, известные заказы исключаются
   * из внешних. Смена ключа после await не смешивает ни строки, ни единицы расходов.
   */
  async syncHistory({ autoImport = false }: { autoImport?: boolean } = {}) {
    return this.locked(async () => {
      const errors: string[] = [];

      for (const provider of this.providers.values()) {
        const captured = provider.snapshot?.();

        if (!captured || !provider.history || !await provider.available()) {
          continue;
        }

        try {
          const usages = await provider.history(captured);

          if (!this.enabled() || !provider.isCurrent?.(captured)) {
            continue;
          }

          for (const usage of usages) {
            const record: RecordedTask = {
              taskId: usage.taskId,
              type: usage.type,
              createdAt: usage.createdAt,
              completedAt: null,
              credits: usage.credits,
              prompt: null,
              inputTaskId: null,
              params: {},
              status: 'unknown',
              rigResult: null,
              source: 'raw',
            };
            const item = this.observe(provider, record, captured.accountKey,
              `Заказ ${usage.taskId.slice(0, 8)}`, []);

            item.usage = usage;
          }

          await this.persist();
          await this.options.observeUsage?.(provider.id, captured, usages);

          if (autoImport) {
            const known = await this.knownTasks();
            const candidates = this.index!.observations.filter((item) => item.provider === provider.id
              && item.accountKey === captured.accountKey && !item.tombstone && !known.has(item.key));

            for (let start = 0; start < candidates.length; start += 100) {
              const slice = candidates.slice(start, start + 100);
              const result = await provider.poll!(slice.map((item) => item.record.taskId), captured);

              if (!this.enabled() || !provider.isCurrent?.(captured)) {
                break;
              }

              for (const task of result.tasks) {
                const item = slice.find((candidate) => candidate.record.taskId === task.id)!;

                await this.importRemote(item, task, captured, false).catch(() => {
                  item.label = 'Файлы не удалось забрать. Можно повторить бесплатно.';
                });
              }
            }
          }
        } catch {
          errors.push(`История ${provider.name} временно недоступна.`);
        }
      }

      this.index!.historyPartial = true;
      this.index!.historyError = errors.join(' ') || null;
      await this.persist();

      return this.externalTasksUnlocked();
    });
  }

  /**
   * Poll даёт состояние и подтверждённые поля, не создаёт облачный заказ.
   * Проверки показываются в истории; expired не превращается в пустую ready модель.
   */
  private async importRemote(item: Observation, task: RemoteTask, captured: AccountSnapshot,
    explicit: boolean): Promise<void> {
    const provider = this.providers.get(item.provider)!;

    if (!provider.isCurrent?.(captured) || task.id !== item.record.taskId || task.type !== item.record.type) {
      throw new Error('account_changed');
    }

    item.record.status = task.state;
    item.record.params = parseStudio3d.values(task.extra.params ?? item.record.params);
    item.record.inputTaskId = typeof task.extra.inputTaskId === 'string'
      ? task.extra.inputTaskId : item.record.inputTaskId;
    item.record.createdAt = task.createdAt ?? item.record.createdAt;
    item.record.completedAt = task.completedAt ?? item.record.completedAt;

    if (task.state === 'expired') {
      item.label = 'Tripo удалил файлы этого заказа.';
      
      return;
    }

    if (provider.taskOperation?.(task.type) === 'rig-check') {
      item.label = 'Проверка скелета — отдельной модели нет.';
      
      return;
    }

    if (task.state !== 'success') {
      item.label = task.error?.message ?? 'Заказ ещё не завершён.';
      
      return;
    }

    await this.importOne(item, 'agent', explicit, task, this.parent(item), captured);
  }

  /**
   * Явный импорт может восстановить удалённую задачу; автоматический — нет.
   * Captured account обязан совпасть после бесплатного poll до публикации.
   */
  async importTask(providerId: string, taskId: string) {
    return this.locked(async () => {
      const provider = this.providers.get(providerId);
      const captured = provider?.snapshot?.();

      if (!provider?.poll || !captured || !TASK_ID.test(taskId)) {
        throw new Error('provider_unavailable');
      }

      const result = await provider.poll([taskId], captured);
      const task = result.tasks.find((entry) => entry.id === taskId);

      if (!task || !provider.isCurrent?.(captured)) {
        throw new Error('task_unavailable');
      }

      const item = this.observe(provider, {
        taskId,
        type: task.type,
        createdAt: task.createdAt,
        completedAt: task.completedAt,
        credits: task.cost,
        prompt: null,
        inputTaskId: null,
        params: {},
        status: task.state,
        rigResult: null,
        source: 'raw',
      }, captured.accountKey, `Заказ ${taskId.slice(0, 8)}`, []);

      await this.importRemote(item, task, captured, true);
      await this.persist();

      if (!item.modelId) {
        throw new Error('task_unavailable');
      }

      return { libraryId: this.options.library.libraryId, modelId: item.modelId };
    });
  }

  /**
   * Известные task IDs берутся и из моделей, и из постоянного журнала заказов.
   * Удалённая модель раздела не появляется заново через наблюдение истории.
   */
  private async knownTasks(): Promise<Set<string>> {
    const known = new Set<string>();

    for (const entry of (await this.options.library.listModels()).entries) {
      for (const version of entry.versions) {
        if (version.task) {
          known.add(this.key(version.task.provider, version.accountKey, version.task.id));
        }
      }
    }

    for (const intent of await this.options.intents?.list() ?? []) {
      for (const child of intent.children) {
        if (child.taskId) {
          known.add(this.key(intent.provider, intent.accountKey, child.taskId));
        }
      }
    }

    return known;
  }

  /**
   * Внешняя строка не включает accountKey, signed URL или путь к task.json.
   * Накопленные tombstones остаются для dedup, но не выдаются как новый заказ.
   */
  private async externalTasksUnlocked() {
    const known = await this.knownTasks();

    for (const item of this.index!.observations) {
      await this.existing(item);
    }

    return this.index!.observations.filter((item) => item.usage && !item.modelId && !item.tombstone
      && this.providers.get(item.provider)?.snapshot?.()?.accountKey === item.accountKey
      && !known.has(item.key)
      && !known.has(this.key(item.provider, null, item.record.taskId))).map((item) => ({
      provider: item.provider,
      taskId: item.record.taskId,
      type: item.record.type,
      label: item.label ?? item.name,
      credits: item.usage?.credits ?? item.record.credits,
      createdAt: item.record.createdAt,
      modelId: null,
    }));
  }

  async externalTasks() {
    return this.locked(() => this.externalTasksUnlocked());
  }

  /**
   * Неделя считается по уникальным известным задачам, отдельно по единицам.
   * Журнал раздела имеет приоритет над usage, короткая история всегда partial.
   */
  async week() {
    return this.locked(async () => {
      const cutoff = this.now() - 7 * 86_400_000;
      const latest = this.now();
      let partial = this.index!.historyPartial;
      const intents = await this.options.intents?.list() ?? [];
      const own = new Set(intents.flatMap((intent) => intent.children.filter((child) => child.taskId)
        .map((child) => this.key(intent.provider, intent.accountKey, child.taskId!))));
      const ownUnknown = new Set(intents.flatMap((intent) => intent.children.filter((child) => child.taskId)
        .map((child) => this.key(intent.provider, null, child.taskId!))));
      const sectionLines: Pick<DiskVersion, 'provider' | 'cost'>[] = intents.flatMap((intent) =>
        intent.children.filter((child) => {
          const at = child.chargedAt ?? child.completedAt ?? child.submittedAt ?? intent.createdAt;

          const when = Date.parse(at);
          
          if (!Number.isFinite(when)) {
            partial = true;
          }
          
          return when >= cutoff && when <= latest;
      }).map((child) => ({
        provider: intent.provider,
        cost: {
          estimated: child.estimated,
          actual: child.actual,
          free: intent.provider === 'local' || child.paymentState === 'free',
          unit: intent.unit,
          state: child.paymentState,
        },
      })));

      const externalLines: Pick<DiskVersion, 'provider' | 'cost'>[] = [];
      
      for (const item of this.index!.observations) {
        if (own.has(item.key) || (item.accountKey === null && ownUnknown.has(item.key))
          || (!item.usage && item.record.credits === null)) {
          continue;
        }

        const at = item.usage?.createdAt ?? item.record.completedAt ?? item.record.createdAt;

        const when = at ? Date.parse(at) : NaN;
        
        if (!Number.isFinite(when)) {
          partial = true;
          continue;
        }
        if (when < cutoff || when > latest) {
          continue;
        }

        const actual = item.usage?.credits ?? item.record.credits;

        externalLines.push({
          provider: item.provider,
          cost: {
            estimated: null,
            actual,
            free: false,
            unit: item.unit,
            state: actual === null ? 'unknown' : 'charged',
          },
        });
      }

      const groupKey = (item: { provider: string; unit: UnitForms | null }) =>
        JSON.stringify([item.provider, item.unit?.one, item.unit?.few, item.unit?.many]);
      const section = new Map(spendingFor(sectionLines).map((item) => [groupKey(item), item.actual]));
      const external = new Map(spendingFor(externalLines).map((item) => [groupKey(item), item.actual]));
      const reserved = new Map<string, number>();
      const lines = [...sectionLines, ...externalLines];
      
      for (const intent of intents) {
        const key = groupKey({ provider: intent.provider, unit: intent.unit });
        
        for (const child of intent.children) {
          if (!['submitting', 'accepted', 'unknown'].includes(child.stage) ||
            child.remote?.state === 'success'
            || intent.provider === 'local' || child.paymentState === 'free') {
              continue;
            }
          
          reserved.set(key, (reserved.get(key) || 0) + (child.actual ?? child.estimated));
          // Старый активный заказ тоже держит резерв, но не увеличивает недельный расход.
          // Нулевая строка добавляет валютную группу, не притворяясь списанием.
          if (!section.has(key) && !external.has(key)) {
            lines.push({ provider: intent.provider,
            cost: {
              estimated: null,
              actual: null,
              free: false,
              unit: intent.unit,
              state: 'unpaid'
            } });
          }
        }
      }
      
      return {
        partial,
        groups: spendingFor(lines).map((item) => ({
          ...item,
          sectionActual: section.get(groupKey(item)) || 0,
          externalActual: external.get(groupKey(item)) || 0,
          reserved: reserved.get(groupKey(item)) || 0
        })),
        historyError: this.index!.historyError,
      };
    });
  }

  /**
   * Остановка отменяет только свои скачивания. Сохранившаяся запись и task ID
   * остаются доступны следующему lifecycle без новой платной отправки.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await withPathLock(`${this.options.library.dir}:importer`, async () => {});
  }
}

export type StudioImporter = ReturnType<typeof createImporter>;
