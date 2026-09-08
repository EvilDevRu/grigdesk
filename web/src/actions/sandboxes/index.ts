// Единственная точка входа раздела «Песочницы» для вида: состояние берётся из стора,
// а всё, что связано с сетью, — из операций. Одна операция — один файл: то, что
// меняется по причине транспорта, не живёт рядом с состоянием.
export { useSandboxesStore } from '../../stores/sandboxes';

export { dismantleSandbox } from './dismantleSandbox';
export { loadSandboxes } from './loadSandboxes';
export { raiseSandbox } from './raiseSandbox';
export { watchSandboxes } from './watchSandboxes';
