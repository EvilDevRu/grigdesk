// Публичный вход каталога Tripo раздела «3D». Прежний набор имён собирается из модулей
// значений, полей, проверок, цен, запросов, ответов и ошибок; новые имена не добавляются.

export {
  ENDPOINTS,
  IDENTITY_TRANSFORM,
  MODEL_H,
  MODEL_P1,
  MODEL_P2,
  NATIVE_ONLY,
  OPERATION_TASK_TYPES,
  RIG_V1,
  RIG_V2,
  SEGMENT_V1,
  SEGMENT_V2,
  TASK_OPERATIONS,
  TEXTURE_V3,
  TEXTURE_V35,
  USD_PER_CREDIT,
  nativeAccepts,
  tripoPool,
} from './catalogValues.ts';
export { tripoOperations } from './catalogFields.ts';
export { tripoValidate } from './catalogValidation.ts';
export { tripoQuote } from './catalogPricing.ts';
export { tripoRequests } from './requestPayload.ts';
export type { TripoInputs, TripoRef, TripoRequest } from './requestPayload.ts';
export { parseTripoTask, parseUsage, recognizeTripoRecord } from './taskResponses.ts';
export { tripoRequestError, tripoTaskError } from './taskErrors.ts';
