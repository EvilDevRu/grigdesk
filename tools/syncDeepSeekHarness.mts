// Импорт по точному SHA не собирает runtime и не переключает current.
// Reviewable candidate публикуется отдельным явно выбранным действием.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  fetchDeepSeekUpstream,
  materializeDeepSeekSnapshot,
  prepareDeepSeekSync,
  publishDeepSeekSync,
} from './deepseekVendorManifest.ts';
import type { PreparedDeepSeekSync, VendorSelection } from './deepseekVendorManifest.ts';

/**
 * Все изменяющие дерево действия явны; неизвестный флаг не расширяет контракт.
 * Подготовка и публикация имеют разные входы, но обе требуют полного commit SHA.
 */
function argumentsOf(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  const allowed = ['--commit', '--source-dir', '--vendor-dir', '--selection', '--staging-parent',
    '--patches-dir', '--candidate', '--publish'];

  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];

    if (!name || !allowed.includes(name) || !value || value.includes('\0') || values.has(name)) {
      throw new Error('Неизвестный, повторённый или неполный аргумент sync');
    }

    values.set(name, value);
  }

  if (!/^[a-f0-9]{40}$/u.test(values.get('--commit') ?? '')) {
    throw new Error('Для sync обязателен явный полный SHA commit');
  }

  return values;
}

/**
 * Candidate recipe лежит вне снимка: оператор видит diff до публикации.
 * Реальная публикация заново проверяет integrity и доступные gates, без commit/push.
 */
async function main(): Promise<void> {
  const args = argumentsOf(process.argv.slice(2));
  const commit = args.get('--commit')!;
  const publication = args.get('--publish');

  if (publication) {
    if (args.size !== 2) {
      throw new Error('--publish допускает только recipe и --commit');
    }

    const candidate = JSON.parse(await fs.readFile(publication, 'utf8')) as PreparedDeepSeekSync;

    if (candidate.manifest?.commit !== commit) {
      throw new Error('Commit candidate не соответствует явному SHA');
    }

    await publishDeepSeekSync(candidate);
    process.stdout.write(`Опубликован source snapshot ${commit}; runtime не переключался.\n`);

    return;
  }

  const vendorDir = path.resolve(args.get('--vendor-dir') ?? 'third_party/deepseek-harness');
  const stagingParent = path.resolve(args.get('--staging-parent')
    ?? '.state/artifacts/deepseek-vendoring/sync');
  const selectionFile = args.get('--selection');

  await fs.mkdir(stagingParent, { recursive: true });

  // Прежний снимок сверяется по своим исходникам: кэш upstream в чистом checkout ещё не подготовлен.
  const existing = await fs.lstat(vendorDir).then(() => true, () => false);
  const previous = existing
    ? await materializeDeepSeekSnapshot(vendorDir, { sourceDir: args.get('--source-dir') })
    : null;

  if (!selectionFile && !previous) {
    throw new Error('Первичный импорт требует --selection');
  }

  const selection: VendorSelection = selectionFile
    ? JSON.parse(await fs.readFile(selectionFile, 'utf8'))
    : previous!.selection;
  const sourceDir = args.get('--source-dir') ?? await fetchDeepSeekUpstream(commit, stagingParent);

  try {
    const candidate = await prepareDeepSeekSync({
      sourceDir,
      vendorDir,
      commit,
      selection,
      stagingParent,
      patchesDir: args.get('--patches-dir'),
    });
    const recipe = path.resolve(args.get('--candidate') ?? path.join(stagingParent, 'candidate.json'));

    await fs.mkdir(path.dirname(recipe), { recursive: true });
    await fs.writeFile(recipe, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ recipe, diff: candidate.diff }, null, 2)}\n`);
  } finally {
    if (!args.has('--source-dir')) {
      await fs.rm(sourceDir, { recursive: true, force: true });
    }
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}
