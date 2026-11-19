import type * as nodeFs from 'node:fs';
import path from 'node:path';

type PlacementFs = Pick<typeof nodeFs, 'lstatSync' | 'realpathSync'>;
type Location = Pick<nodeFs.Stats, 'dev' | 'ino'>;

export class DataHomeError extends Error {}

export interface DataHomePlacementInput {
  codeRoot: string;
  home: string;
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/**
 * Канонизирует существующих предков без создания ещё отсутствующего хвоста.
 * Висячая ссылка и ошибка доступа не считаются отсутствующими сегментами.
 */
export function canonicalDataPath(file: string, fs: PlacementFs): string {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    if (!missing(error) || path.dirname(file) === file) {
      throw error;
    }

    let link = false;

    try {
      link = fs.lstatSync(file).isSymbolicLink();
    } catch (statError) {
      if (!missing(statError)) {
        throw statError;
      }
    }

    if (link) {
      throw error;
    }

    return path.join(canonicalDataPath(path.dirname(file), fs), path.basename(file));
  }
}

/**
 * Существующие каталоги подтверждаются физическими inode после realpath.
 * Отсутствующий хвост остаётся без identity до фактического создания.
 */
function branch(physical: string, fs: PlacementFs) {
  let current = '/';
  let absent = false;

  return physical.split('/').filter(Boolean).map((name) => {
    current = path.join(current, name);

    let identity: Location | null = null;

    if (!absent) {
      try {
        const stat = fs.lstatSync(current);

        if (!stat.isDirectory()) {
          throw new DataHomeError('Существующий сегмент размещения должен быть каталогом.');
        }

        identity = stat;
      } catch (error) {
        if (!missing(error)) {
          throw error;
        }

        absent = true;
      }
    }

    return { name, identity };
  });
}

type Component = ReturnType<typeof branch>[number];

/**
 * При неизвестной конфигурации APFS отсутствующие ASCII-имена считаются
 * без учёта регистра. Для неоднозначной Unicode-ветки требуется готовый каталог.
 */
function sameComponent(left: Component, right: Component): boolean {
  if (left.identity && right.identity) {
    return left.identity.dev === right.identity.dev && left.identity.ino === right.identity.ino;
  }

  if (left.name === right.name) {
    return true;
  }

  if (/[^\x20-\x7e]/u.test(left.name + right.name)) {
    throw new DataHomeError('installation_data_placement_ambiguous');
  }

  return left.name.toLowerCase() === right.name.toLowerCase();
}

const contains = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);

/**
 * Отклоняет HOME как D и вложенность I/D в обоих направлениях.
 * Linux сохраняет лексическое сравнение канонических путей.
 */
export function checkDataHomePlacement(
  selected: string, input: DataHomePlacementInput, fs: PlacementFs, platform = process.platform,
): void {
  const target = canonicalDataPath(selected, fs);
  const code = canonicalDataPath(path.resolve(input.codeRoot), fs);
  const home = canonicalDataPath(path.resolve(input.home), fs);
  let overlap = target === home || contains(code, target) || contains(target, code);

  if (!overlap && platform === 'darwin') {
    const dataBranch = branch(target, fs);
    const codeBranch = branch(code, fs);
    const homeBranch = branch(home, fs);
    const shortest = dataBranch.length < codeBranch.length ? dataBranch : codeBranch;
    const longest = shortest === dataBranch ? codeBranch : dataBranch;

    overlap = shortest.every((part, index) => sameComponent(part, longest[index]!))
      || dataBranch.length === homeBranch.length
        && dataBranch.every((part, index) => sameComponent(part, homeBranch[index]!));
  }

  if (overlap) {
    throw new DataHomeError('Папка данных не должна совпадать с HOME, лежать внутри кода или содержать его.');
  }
}
