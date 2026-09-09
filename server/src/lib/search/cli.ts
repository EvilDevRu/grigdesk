#!/usr/bin/env node
import { config } from '../../config.js';
import { pathToFileURL } from 'node:url';
import { openKnowledgeStorage } from './storage.ts';
import { createKnowledgeTransfer } from './transfer.ts';
import { PrefsStore } from '../prefs-store.js';
import { projectMapsRoot } from '../projects.js';
import { runKnowledgeSearchRuntimePreflight } from './runtimePreflight.ts';

const SOURCE_DOCUMENT_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

type Payload = Record<string, unknown>;

// Разобранная команда записи. `id` есть только у правки: у создания вместо него
// проект, и смешивать их нельзя — CAS-ревизия относится к уже существующей записи.
interface WriteInput {
  id?: string;
  project?: string;
  expectedRevision?: number;
  record: Payload;
}

// Хранилище знаний в том виде, в каком его зовёт CLI.
interface KnowledgeStorage {
  search: (input: Payload) => Promise<{ items: unknown[] }>;
  read: (id: string) => Promise<Payload | null>;
  create: (input: Payload) => Promise<Payload | null>;
  update: (id: string, input: Payload) => Promise<Payload | null>;
  exportSnapshot: () => Promise<unknown>;
  previewImport: (records: unknown) => Promise<unknown>;
  applyImport: (records: unknown, resolutions: unknown) => Promise<unknown>;
  close?: () => Promise<unknown> | unknown;
}

interface CliOptions {
  dbPath?: string;
  rootDir?: string;
  env?: Payload;
  preflight?: () => Promise<{ ok: boolean; reasonCode?: string }>;
  openStorage?: (options: Payload) => Promise<KnowledgeStorage>;
  mapsRootFor?: ((project: string) => Promise<unknown> | unknown) | null;
  io?: {
    stdout: { write: (text: string) => unknown };
    stderr: { write: (text: string) => unknown };
  };
}

function usage(stderr: { write: (text: string) => unknown } = process.stderr) {
  stderr.write(
    'Использование: knowledge search <запрос> [--project ID] [--repository ID] '
      + '[--tag TAG] [--limit N]\n'
      + '               knowledge read <uuid>\n'
      + '               knowledge write --project P --repository R --kind K --title T '
      + '--body B --tag TOPIC [--tag TAG]\n'
      + '               knowledge write <uuid> --expected-revision N --repository R '
      + '--kind K --title T --body B --tag TOPIC [--tag TAG]\n',
  );
}

function parseSearch(args: string[]): Payload | null {
  if (!args.length || String(args[0]).startsWith('--')) {
    return null;
  }

  const result: Payload & { tags?: string[] } = { query: args[0], tags: [] };
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!['--project', '--repository', '--tag', '--limit'].includes(String(flag)) || value == null) {
      return null;
    }
    index += 1;
    if (flag === '--project') {
      result.project = value;
    } else if (flag === '--repository') {
      result.repository = value;
    } else if (flag === '--tag') {
      result.tags?.push(value);
    } else {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return null;
      }
      result.limit = limit;
    }
  }
  if (!result.tags?.length) {
    delete result.tags;
  }

  return result;
}

function parseWrite(args: string[]): WriteInput | null {
  const rest = [...args];
  const id = rest[0] && !rest[0].startsWith('--') ? String(rest.shift()) : '';
  const values = new Map<string, string>();
  const tags: string[] = [];
  const allowed = new Set([
    '--project', '--repository', '--kind', '--title', '--body', '--tag', '--expected-revision',
  ]);
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!allowed.has(String(flag)) || value === undefined
      || (flag !== '--tag' && values.has(String(flag)))) {
      return null;
    }
    if (flag === '--tag') {
      tags.push(value);
    } else {
      values.set(String(flag), value);
    }
  }

  const create = !id;
  const project = values.get('--project');
  const revisionText = values.get('--expected-revision');
  const revision = Number(revisionText);
  if ((create && (!project?.trim() || revisionText !== undefined))
    || (!create && (project !== undefined || !Number.isInteger(revision) || revision < 1))) {
    return null;
  }
  const record = {
    repository: values.get('--repository'),
    kind: values.get('--kind'),
    title: values.get('--title'),
    body: values.get('--body'),
    tags,
  };
  if ([record.repository, record.kind, record.title].some((value) => !value?.trim())
    || record.body === undefined || !tags.length || !SOURCE_DOCUMENT_RE.test(String(tags[0]))) {
    return null;
  }

  return {
    ...(id ? { id, expectedRevision: revision } : { project: String(project).trim() }),
    record,
  };
}

function provenanceFrom(env: Payload | undefined) {
  const pipelineRef = String(
    env?.FACTORY_LIFECYCLE_NODE_ID || env?.FACTORY_RUN_STAGE || '',
  ).trim();
  return pipelineRef
    ? { actor: 'executor', channel: 'pipeline', ref: pipelineRef }
    : { actor: 'executor', channel: 'cli', ref: 'direct' };
}

function mapSource(record: Payload | null): string {
  const sourceDocument = String((record?.tags as unknown[] | undefined)?.[0] || '');

  return SOURCE_DOCUMENT_RE.test(sourceDocument) ? sourceDocument : '';
}

/** CLI печатает только безопасный JSON-контракт и различает empty от отказа кодом. */
export async function runKnowledgeCli(
  args: string[] = process.argv.slice(2),
  options: CliOptions = {},
): Promise<number> {
  const {
    dbPath = config.knowledgeDbPath,
    rootDir = config.rootDir,
    env = process.env,
    preflight = runKnowledgeSearchRuntimePreflight,
    openStorage = openKnowledgeStorage,
    mapsRootFor = null,
    io = process,
  } = options;
  const [command, ...rest] = args;
  const searchInput = command === 'search' ? parseSearch(rest) : null;
  const readId = command === 'read' && rest.length === 1 ? rest[0] : '';
  const writeInput = command === 'write' ? parseWrite(rest) : null;
  if (!searchInput && !readId && !writeInput) {
    usage(io.stderr);
    return 64;
  }

  const runtime = await preflight();
  if (!runtime.ok) {
    io.stderr.write(`knowledge_unavailable: ${runtime.reasonCode || 'runtime'}\n`);
    return 2;
  }

  let storage: KnowledgeStorage | undefined;

  try {
    try {
      storage = await openStorage({
        dbPath,
        seedSamples: false,
        readOnly: command !== 'write',
      });
    } catch (error) {
      // Первый поиск сохраняет прежний UX: создаёт пустую схему. Существующую
      // базу search/read открывают строго read-only и не требуют chmod в sandbox.
      if (command === 'write'
        || (error as { reasonCode?: unknown } | null)?.reasonCode !== 'db_missing') {
        throw error;
      }
      storage = await openStorage({ dbPath, seedSamples: false, readOnly: false });
    }
    const store = storage as KnowledgeStorage;

    if (command === 'search') {
      const result = await store.search(searchInput as Payload);
      io.stdout.write(`${JSON.stringify(result)}\n`);
      return result.items.length ? 0 : 1;
    }
    if (command === 'read') {
      const record = await store.read(String(readId));
      io.stdout.write(`${JSON.stringify({ record })}\n`);
      return record ? 0 : 1;
    }

    const write = writeInput as WriteInput;
    const previous = write.id ? await store.read(write.id) : null;

    if (write.id && !previous) {
      io.stdout.write(`${JSON.stringify({ record: null })}\n`);
      return 1;
    }
    const oldSource = previous ? mapSource(previous) : '';
    const newSource = mapSource(write.record);
    if (!newSource || (previous && !oldSource)) {
      io.stderr.write('invalid_arguments: первый тег должен задавать безопасную тему карты\n');
      return 64;
    }
    const provenance = provenanceFrom(env);
    const record = await (write.id
      ? store.update(write.id, {
        ...write.record,
        expectedRevision: write.expectedRevision,
        provenance,
      })
      : store.create({
        ...write.record,
        project: write.project,
        provenance,
      })) as Payload;
    const sourceDocuments = [...new Set([oldSource, newSource].filter(Boolean))];
    try {
      const transfer = createKnowledgeTransfer({
        rootDir,
        dbPath,
        knowledge: store,
        mapsRootFor: mapsRootFor || ((project: string) => projectMapsRoot({
          config,
          prefs: new PrefsStore({ prefsPath: config.prefsPath }),
          id: project,
        })),
      });
      await transfer.updateMaps({ project: record.project, sourceDocuments });
    } catch {
      io.stderr.write(`${JSON.stringify({
        error: 'maps_refresh_failed',
        committed: true,
        id: record.id,
        revision: record.revision,
      })}\n`);
      return 2;
    }
    io.stdout.write(`${JSON.stringify({ record })}\n`);
    return 0;
  } catch (error) {
    const failure = error as { code?: unknown; reasonCode?: unknown; currentRevision?: unknown }
      | null;

    if (failure?.code === 'KNOWLEDGE_NOT_FOUND') {
      io.stdout.write(`${JSON.stringify({ record: null })}\n`);

      return 1;
    }
    if (failure?.code === 'KNOWLEDGE_CONFLICT') {
      io.stderr.write(`${JSON.stringify({
        error: 'knowledge_conflict',
        currentRevision: failure.currentRevision,
      })}\n`);

      return 2;
    }

    const reason = failure?.reasonCode || 'storage';
    io.stderr.write(`knowledge_unavailable: ${reason}\n`);
    return 2;
  } finally {
    await storage?.close?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runKnowledgeCli();
}
