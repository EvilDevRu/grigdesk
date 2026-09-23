// Единственная точка входа раздела «Проекты» для вида: состояние берётся из стора,
// а всё, что связано с сетью и событиями, — из операций. Одна операция — один файл:
// то, что меняется по причине транспорта, не живёт рядом с состоянием.
export { useProjectsStore } from '../../stores/projects';

export { archiveProject } from './archiveProject';
export { checkRepositories } from './checkRepositories';
export { loadDependencies } from './loadDependencies';
export { restoreProject } from './restoreProject';
export { loadProject } from './loadProject';
export { loadProjects } from './loadProjects';
export { saveProject } from './saveProject';
export { watchProjects } from './watchProjects';
