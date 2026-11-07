// Минимальный контракт путей source-установки нужен и раннему guard, и resolver DeepSeek.
// Clean checkout переносит оба модуля вместе, не копируя установленный ELF или runtime cache.
export const SOURCE_RUNTIME_FILES = [
  'server/src/lib/runtimePaths.ts',
  'server/src/lib/runtimeBuildContext.ts',
  'shared/node/bundleLayout.ts',
] as const;
