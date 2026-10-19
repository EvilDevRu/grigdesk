// Общие типы и ошибки не привязаны к Node или generation сервера.
// Legacy host verifier остался только в helpers тестов перехода.
export {
  deepSeekRuntimeError,
  type DeepSeekArtifact,
  type DeepSeekArtifactContract,
  type DeepSeekArtifactHeader,
} from '../../../../shared/node/deepSeekArtifact.ts';
