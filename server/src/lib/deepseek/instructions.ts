import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

export interface DeepSeekInstructionSource {
  file: string;
  line: number;
  target: string;
  status: string;
}

const INSTRUCTION_FILES = Object.freeze([
  'AGENTS.md',
  'CLAUDE.md',
  'AGENTS.local.md',
  'CLAUDE.local.md',
]);
const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 3,
  maxTotalBytes: 256 * 1024,
  maxFileBytes: 64 * 1024,
});

interface Directive {
  line: number;
  target: string;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function projectPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/') || '.';
}

function directives(text: string): Directive[] {
  const result: Directive[] = [];
  let fence = '';
  text.split('\n').forEach((rawLine, index) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const marker = line.trimStart().match(/^(```|~~~)/u)?.[1] || '';
    if (marker) {
      if (!fence) fence = marker;
      else if (fence === marker) fence = '';
      return;
    }
    if (fence) return;
    const match = line.match(/^@(\S+)$/u);
    const target = match?.[1] || '';
    if (target && !target.startsWith('#/knowledge/')) {
      result.push({ line: index + 1, target });
    }
  });
  return result;
}

function positiveLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * DSH сам читает основные AGENTS/CLAUDE-файлы. Здесь stateless раскрываются только
 * точные `@путь`, которые upstream оставляет обычным текстом.
 */
export async function expandInstructionImports(options: {
  projectRoot: string;
  cwd: string;
  limits?: { maxDepth?: number; maxTotalBytes?: number; maxFileBytes?: number };
}): Promise<{ context: string; sources: DeepSeekInstructionSource[] }> {
  if (!path.isAbsolute(options.projectRoot) || !path.isAbsolute(options.cwd)) {
    throw new TypeError('projectRoot и cwd должны быть абсолютными');
  }
  const [projectRoot, cwd] = await Promise.all([
    fs.realpath(options.projectRoot),
    fs.realpath(options.cwd),
  ]);
  if (!inside(projectRoot, cwd)) {
    throw new TypeError('cwd должен находиться внутри projectRoot');
  }
  const maxDepth = positiveLimit(options.limits?.maxDepth, DEFAULT_LIMITS.maxDepth);
  const maxTotalBytes = positiveLimit(
    options.limits?.maxTotalBytes,
    DEFAULT_LIMITS.maxTotalBytes,
  );
  const maxFileBytes = positiveLimit(options.limits?.maxFileBytes, DEFAULT_LIMITS.maxFileBytes);
  const sources: DeepSeekInstructionSource[] = [];
  const context: string[] = [];
  const visited = new Set<string>();
  let totalBytes = 0;

  const recordSkip = (
    sourceFile: string,
    directive: Directive,
    reason: string,
  ) => {
    sources.push({
      file: projectPath(projectRoot, sourceFile),
      line: directive.line,
      target: directive.target,
      status: `skipped: ${reason}`,
    });
    context.push(`(импорт \`${directive.target}\` пропущен: ${reason})`);
  };

  const expand = async (
    sourceFile: string,
    directive: Directive,
    depth: number,
    stack: ReadonlySet<string>,
  ): Promise<void> => {
    if (depth > maxDepth) {
      recordSkip(sourceFile, directive, 'depth');
      return;
    }
    const unresolved = path.resolve(path.dirname(sourceFile), directive.target);
    let target: string;
    try {
      target = await fs.realpath(unresolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        recordSkip(sourceFile, directive, 'missing');
        return;
      }
      throw error;
    }
    if (!inside(projectRoot, target)) {
      recordSkip(sourceFile, directive, 'outside_root');
      return;
    }
    if (stack.has(target)) {
      recordSkip(sourceFile, directive, 'cycle');
      return;
    }
    if (visited.has(target)) {
      recordSkip(sourceFile, directive, 'duplicate');
      return;
    }
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > maxFileBytes || totalBytes + stat.size > maxTotalBytes) {
      recordSkip(sourceFile, directive, 'too_large');
      return;
    }
    const bytes = await fs.readFile(target);
    if (bytes.includes(0)) {
      recordSkip(sourceFile, directive, 'binary');
      return;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      recordSkip(sourceFile, directive, 'binary');
      return;
    }
    visited.add(target);
    totalBytes += bytes.byteLength;
    sources.push({
      file: projectPath(projectRoot, sourceFile),
      line: directive.line,
      target: directive.target,
      status: 'imported',
    });
    context.push([
      `## Импорт ${projectPath(projectRoot, target)} (из ${projectPath(projectRoot, sourceFile)})`,
      '',
      text.replace(/\n*$/u, ''),
    ].join('\n'));
    const nextStack = new Set(stack);
    nextStack.add(target);
    for (const nested of directives(text)) {
      await expand(target, nested, depth + 1, nextStack);
    }
  };

  const relative = path.relative(projectRoot, cwd);
  const parts = relative ? relative.split(path.sep) : [];
  const directories = [projectRoot];
  for (let index = 1; index <= parts.length; index += 1) {
    directories.push(path.join(projectRoot, ...parts.slice(0, index)));
  }
  for (const directory of directories) {
    for (const name of INSTRUCTION_FILES) {
      const sourceFile = path.join(directory, name);
      let text: string;
      try {
        text = await fs.readFile(sourceFile, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        throw error;
      }
      for (const directive of directives(text)) {
        await expand(sourceFile, directive, 1, new Set());
      }
    }
  }

  return {
    context: context.length ? `${context.join('\n\n')}\n` : '',
    sources,
  };
}
