#!/usr/bin/env node
import { config } from '../../config.js';
import { pathToFileURL } from 'node:url';
import { openKnowledgeStorage } from './storage.js';
import { createKnowledgeTransfer } from './transfer.js';
import { PrefsStore } from '../prefs-store.js';
import { projectMapsRoot } from '../projects.js';
import { runKnowledgeSearchRuntimePreflight } from './runtime-preflight.js';

const SOURCE_DOCUMENT_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function usage(stderr = process.stderr) {
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

function parseSearch(args) {
  if (!args.length || args[0].startsWith('--')) {
    return null;
  }
  const result = { query: args[0], tags: [] };
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!['--project', '--repository', '--tag', '--limit'].includes(flag) || value == null) {
      return null;
    }
    index += 1;
    if (flag === '--project') {
      result.project = value;
    } else if (flag === '--repository') {
      result.repository = value;
    } else if (flag === '--tag') {
      result.tags.push(value);
    } else {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return null;
      }
      result.limit = limit;
    }
  }
  if (!result.tags.length) {
    delete result.tags;
  }
  return result;
}

function parseWrite(args) {
  const rest = [...args];
  const id = rest[0] && !rest[0].startsWith('--') ? rest.shift() : '';
  const values = new Map();
  const tags = [];
  const allowed = new Set([
    '--project', '--repository', '--kind', '--title', '--body', '--tag', '--expected-revision',
  ]);
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!allowed.has(flag) || value === undefined || (flag !== '--tag' && values.has(flag))) {
      return null;
    }
    if (flag === '--tag') {
      tags.push(value);
    } else {
      values.set(flag, value);
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
    || record.body === undefined || !tags.length || !SOURCE_DOCUMENT_RE.test(tags[0])) {
    return null;
  }
  return {
    ...(id ? { id, expectedRevision: revision } : { project: project.trim() }),
    record,
  };
}

function provenanceFrom(env) {
  const pipelineRef = String(
    env?.FACTORY_LIFECYCLE_NODE_ID || env?.FACTORY_RUN_STAGE || '',
  ).trim();
  return pipelineRef
    ? { actor: 'executor', channel: 'pipeline', ref: pipelineRef }
    : { actor: 'executor', channel: 'cli', ref: 'direct' };
}

function mapSource(record) {
  const sourceDocument = record?.tags?.[0];
  return SOURCE_DOCUMENT_RE.test(String(sourceDocument || '')) ? sourceDocument : '';
}

/** CLI печатает только безопасный JSON-контракт и различает empty от отказа кодом. */
export async function runKnowledgeCli(args = process.argv.slice(2), options = {}) {
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

  let storage;
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
      if (command === 'write' || error?.reasonCode !== 'db_missing') {
        throw error;
      }
      storage = await openStorage({ dbPath, seedSamples: false, readOnly: false });
    }
    if (command === 'search') {
      const result = await storage.search(searchInput);
      io.stdout.write(`${JSON.stringify(result)}\n`);
      return result.items.length ? 0 : 1;
    }
    if (command === 'read') {
      const record = await storage.read(readId);
      io.stdout.write(`${JSON.stringify({ record })}\n`);
      return record ? 0 : 1;
    }

    const previous = writeInput.id ? await storage.read(writeInput.id) : null;
    if (writeInput.id && !previous) {
      io.stdout.write(`${JSON.stringify({ record: null })}\n`);
      return 1;
    }
    const oldSource = previous ? mapSource(previous) : '';
    const newSource = mapSource(writeInput.record);
    if (!newSource || (previous && !oldSource)) {
      io.stderr.write('invalid_arguments: первый тег должен задавать безопасную тему карты\n');
      return 64;
    }
    const provenance = provenanceFrom(env);
    const record = writeInput.id
      ? await storage.update(writeInput.id, {
        ...writeInput.record,
        expectedRevision: writeInput.expectedRevision,
        provenance,
      })
      : await storage.create({
        ...writeInput.record,
        project: writeInput.project,
        provenance,
      });
    const sourceDocuments = [...new Set([oldSource, newSource].filter(Boolean))];
    try {
      const transfer = createKnowledgeTransfer({
        rootDir,
        knowledge: storage,
        mapsRootFor: mapsRootFor || ((project) => projectMapsRoot({
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
    if (error?.code === 'KNOWLEDGE_NOT_FOUND') {
      io.stdout.write(`${JSON.stringify({ record: null })}\n`);
      return 1;
    }
    if (error?.code === 'KNOWLEDGE_CONFLICT') {
      io.stderr.write(`${JSON.stringify({
        error: 'knowledge_conflict',
        currentRevision: error.currentRevision,
      })}\n`);
      return 2;
    }
    const reason = error?.reasonCode || 'storage';
    io.stderr.write(`knowledge_unavailable: ${reason}\n`);
    return 2;
  } finally {
    await storage?.close?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runKnowledgeCli();
}
