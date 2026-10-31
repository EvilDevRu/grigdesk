import { isRecord } from '../../../../shared/lib/objects.ts';

import { installError } from './errors.ts';

/**
 * Root и transitively объявленные зависимости разрешают только registry specifiers.
 * Все категории проходят проверку, даже если npm ci будет omit=dev.
 */
export function validateNpmDeclarations(value: Record<string, unknown>): void {
  if (Object.hasOwn(value, 'workspaces')) {
    throw installError('package_unsupported');
  }

  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (!Object.hasOwn(value, field)) {
      continue;
    }

    const declarations = value[field];

    if (!isRecord(declarations)) {
      throw installError('manifest_invalid');
    }

    for (const [name, spec] of Object.entries(declarations)) {
      if (!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/iu.test(name)
        || typeof spec !== 'string' || !spec.trim()
        || !/^[a-z0-9.*^~<>=|+\s-]+$/iu.test(spec)) {
        throw installError('package_unsupported');
      }
    }
  }
}

/**
 * Lock v2/v3 обязан описывать весь graph через packages с integrity.
 * Legacy dependencies v2 проверяются тоже, чтобы скрытый resolved не выбрал Git.
 */
export function validateNpmLock(value: Record<string, unknown>): void {
  if (value.lockfileVersion !== 2 && value.lockfileVersion !== 3 || !isRecord(value.packages)) {
    throw installError('package_unsupported');
  }

  for (const [relative, raw] of Object.entries(value.packages)) {
    if (!isRecord(raw)) {
      throw installError('manifest_invalid');
    }

    validateNpmDeclarations(raw);

    if (relative === '') {
      continue;
    }

    const segment = 'node_modules/(?:@[a-z0-9_.-]+/)?[a-z0-9_.-]+';
    const packagePath = new RegExp(`^${segment}(?:/${segment})*$`, 'iu');

    if (!packagePath.test(relative)) {
      throw installError('package_unsupported');
    }

    validateLockEntry(raw);
  }

  if (Object.hasOwn(value, 'dependencies')) {
    const pending: unknown[] = [value.dependencies];

    while (pending.length > 0) {
      const dependencies = pending.pop();

      if (!isRecord(dependencies)) {
        throw installError('manifest_invalid');
      }

      for (const entry of Object.values(dependencies)) {
        if (!isRecord(entry)) {
          throw installError('manifest_invalid');
        }

        validateLockEntry(entry);

        if (Object.hasOwn(entry, 'dependencies')) {
          pending.push(entry.dependencies);
        }
      }
    }
  }
}

/**
 * Любой non-root entry обязан быть registry tarball с integrity, без links.
 * URL разбирается структурно: похожий домен, userinfo и query не подходят.
 */
function validateLockEntry(value: Record<string, unknown>): void {
  if (value.link || typeof value.version !== 'string' || /[:/\\]/u.test(value.version)
    || typeof value.resolved !== 'string' || typeof value.integrity !== 'string'
    || !/^(?:sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2})(?:\s+sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2})*$/u
      .test(value.integrity)) {
    throw installError('package_unsupported');
  }

  try {
    const url = new URL(value.resolved);

    if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.port
      || url.username || url.password || url.search || url.hash || url.pathname === '/') {
      throw installError('package_unsupported');
    }
  } catch {
    throw installError('package_unsupported');
  }
}
