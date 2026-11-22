import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { goCandidate } from './goCandidate.mts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const built = new Map<string, string>();
const components = new Map([
  ['tracker', 'tracker'], ['pipeline', 'pipeline'], ['routes', 'routes'], ['voice', 'voice'],
  ['grigdesk-ctl', 'ctl'], ['grigdesk-maintenance', 'maintenance'], ['grigdesk-relay', 'relay'],
  ['factory', 'factory'],
]);

/**
 * Готовит локальный бинарник в физическом временном каталоге.
 * Повторный вызов в том же процессе использует уже построенный файл.
 */
export function buildTestGo(name: string, argv: string[], pkg: string): string {
  const cached = built.get(name);

  if (cached) {
    return cached;
  }

  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'grigdesk-test-build-')));
  const binary = path.join(dir, name);

  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  execFileSync('go', [...argv, '-o', binary, pkg], {
    cwd: root,
    env: {
      ...process.env,
      GOWORK: 'off',
      GOTOOLCHAIN: 'local',
      GOFLAGS: '',
      CGO_ENABLED: '0',
    },
    timeout: 120000,
    stdio: 'pipe',
  });
  built.set(name, binary);

  return binary;
}

/**
 * Возвращает явно переданный кандидат или собирает локальный файл для интеграции.
 * Сборка читает версию из репозитория и публикует файл только во временном каталоге.
 */
export function fixtureGo(name: string): string {
  if (process.env.GRIGDESK_GO_UTILITIES_TEST_BIN_DIR !== undefined) {
    return goCandidate(name);
  }

  const component = components.get(name);

  if (!component) {
    throw new Error('Неизвестная Go-утилита ' + name);
  }

  const version = readFileSync(path.join(root, 'VERSION'), 'utf8').trim();

  return buildTestGo(name, ['build', '-trimpath', '-ldflags', '-X main.version=' + version],
    `./utilities/${component}/cmd/${component}`);
}
