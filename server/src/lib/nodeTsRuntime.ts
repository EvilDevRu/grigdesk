// Флаги Node для собственных точек входа на TypeScript.
//
// Сервер исполняет TS снятием типов, но дочерний процесс НЕ наследует `execArgv`
// родителя: `spawn(process.execPath, [...])` стартует с голыми флагами. На текущем
// Node снятие типов включено по умолчанию, на минимальной поддерживаемой 22.13 —
// ещё нет, поэтому пропуск флага ломает запуск ровно у того, кто держит минимум.

// Порядок и состав совпадают с shell-лаунчерами (`bin/lib/runtime-env.sh`):
// предупреждение об экспериментальности гасится, чтобы оно не смешивалось
// с диагностикой самой точки входа.
export const NODE_TS_ARGS: readonly string[] = Object.freeze([
    '--disable-warning=ExperimentalWarning',
    '--experimental-strip-types',
]);

/**
 * Аргументы запуска собственной TS-программы отдельным процессом: флаги идут
 * перед путём, иначе Node примет их за аргументы самой программы.
 */
export function nodeTsArgv(scriptPath: string, args: readonly string[] = []): string[] {
    return [...NODE_TS_ARGS, scriptPath, ...args];
}
