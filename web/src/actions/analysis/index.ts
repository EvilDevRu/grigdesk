// Единственная точка входа раздела «Триаж» для видов: состояние берётся из стора,
// а всё, что связано с сетью и опросом, — из операций. Одна операция — один файл:
// то, что меняется по причине транспорта, не живёт рядом с состоянием.
export { useAnalysisStore } from '../../stores/analysis.ts';

export { analyzeTask } from './analyzeTask.ts';
export { dismissAnalysis } from './dismissAnalysis.ts';
export { loadAnalysis } from './loadAnalysis.ts';
export { readAnalysisDetail } from './readAnalysisDetail.ts';
export {
  analysisPolling,
  scheduleAnalysisPolling,
  startAnalysisPolling,
  stopAnalysisPolling,
} from './pollAnalysis.ts';
