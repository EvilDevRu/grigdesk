// Единственная точка входа раздела «Презентации» для вида: состояние берётся из
// стора, а всё, что связано с сетью, — из операций. Одна операция — один файл:
// то, что меняется по причине транспорта, не живёт рядом с состоянием.
export { useShowcaseStore } from '../../stores/showcase';

export {
  addShowcaseScene,
  importShowcaseAudio,
  removeShowcaseScene,
  reorderShowcaseScenes,
  updateShowcaseScene,
} from './editShowcaseScenes';
export {
  assembleShowcase,
  proposeShowcaseBrief,
  proposeShowcaseScript,
  recordShowcase,
  synthesizeShowcase,
} from './buildShowcase';
export { analyzeShowcase } from './analyzeShowcase';
export { buildShowcaseFilm } from './buildShowcaseFilm';
export { cancelShowcaseJob } from './cancelShowcaseJob';
export { closeShowcaseProject, openShowcaseProject } from './openShowcaseProject';
export {
  loadSeedStatus,
  markShowcaseDataUpdated,
  prepareShowcaseData,
} from './prepareShowcaseData';
export type { SeedStatus } from './prepareShowcaseData';
export { createShowcaseProject } from './createShowcaseProject';
export { deleteShowcaseProject } from './deleteShowcaseProject';
export { loadShowcase } from './loadShowcase';
export {
  cancelShowcaseVoiceInstall,
  installShowcaseVoice,
  loadShowcaseVoices,
  setShowcaseVoice,
} from './setupShowcaseVoice';
export type { ShowcaseVoiceChoice } from './setupShowcaseVoice';
export { watchShowcase } from './watchShowcase';
