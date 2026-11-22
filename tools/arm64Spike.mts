import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const glibcName = /^GLIBC_([0-9]+(?:\.[0-9]+)*)$/u;
const otherVersionName = /^[A-Z][A-Z0-9]*_[0-9]+(?:\.[0-9]+)*$/u;
const needsStart = /Version needs section/u;
const otherSection = /Version (definition|symbol) section/u;
const nameLine = /Name:\s+(\S+)/u;

/**
 * Сравнивает версии GLIBC по числовым компонентам, а не лексикографически:
 * 2.10 старше 2.9, недостающие компоненты считаются нулём.
 */
function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  const length = Math.max(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);

    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

/**
 * Выбирает максимальную требуемую версию GLIBC из вывода readelf --version-info.
 * Берутся только секции Version needs; определения версий и адреса символов
 * исключаются. Версии прочих библиотек (GLIBCXX, LIBCTF…) и GLIBC_PRIVATE
 * не влияют на glibc floor; неразобранное имя не даёт положительного результата,
 * статический ELF без импортов возвращает null («нет требования GLIBC»).
 */
export function parseGlibcFloor(readelfOutput: string): string | null {
  let inNeeds = false;
  let floor: string | null = null;

  for (const line of readelfOutput.split('\n')) {
    if (needsStart.test(line)) {
      inNeeds = true;
      continue;
    }

    if (otherSection.test(line)) {
      inNeeds = false;
      continue;
    }

    if (!inNeeds) {
      continue;
    }

    const name = nameLine.exec(line)?.[1];

    if (!name) {
      continue;
    }

    const glibc = glibcName.exec(name)?.[1];

    if (glibc) {
      if (floor === null || compareVersions(glibc, floor) > 0) {
        floor = glibc;
      }

      continue;
    }

    if (name !== 'GLIBC_PRIVATE' && !otherVersionName.test(name)) {
      throw new Error('glibc_floor_unparsed_dependency');
    }
  }

  return floor;
}

/**
 * Измеряет фактический glibc floor одного ELF через LC_ALL=C readelf
 * --version-info --wide. Ошибка чтения отвергается до положительного результата.
 */
export async function measureElfGlibcFloor(binary: string): Promise<string | null> {
  let stdout: string;

  try {
    ({ stdout } = await execute('readelf', ['--version-info', '--wide', binary], {
      env: { ...process.env, LC_ALL: 'C' },
      maxBuffer: 16 * 1024 * 1024,
    }));
  }
  catch {
    throw new Error('glibc_floor_read_failed');
  }

  return parseGlibcFloor(stdout);
}

/**
 * CLI пробы: измеряет переданные ELF и печатает JSON-отчёт для журнала
 * (максимум по поставке передаётся в схему платформы шага 8).
 */
async function main() {
  const files = process.argv.slice(2);

  if (files.length === 0) {
    throw new Error('arm64_spike_no_files');
  }

  const report: Record<string, string | null> = {};

  for (const file of files) {
    report[file] = await measureElfGlibcFloor(file);
  }

  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
