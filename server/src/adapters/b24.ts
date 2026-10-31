// Совместимое имя для потребителей прежнего HTTP-фасада и личных подборок.
// Сессия и реализация внешнего трекера принадлежат только драйверу реестра.
export { TrackerFacade as B24Adapter } from '../lib/trackers/facade.ts';
export type { TrackerIdentity as B24AccountIdentity } from '../lib/trackers/contract.ts';
