// Единственный allowlist локальных моделей речи. Полная ревизия не даёт обновлению
// faster-whisper незаметно подменить веса под прежним коротким именем модели.

function model(modelId, repo, revision, aliases = []) {
  return Object.freeze({ modelId, repo, revision, aliases: Object.freeze([...aliases]) });
}

export const SPEECH_MODEL_CATALOG = Object.freeze({
  small: model(
    'small',
    'Systran/faster-whisper-small',
    '536b0662742c02347bc0e980a01041f333bce120',
  ),
  medium: model(
    'medium',
    'Systran/faster-whisper-medium',
    '08e178d48790749d25932bbc082711ddcfdfbc4f',
  ),
  'large-v3': model(
    'large-v3',
    'Systran/faster-whisper-large-v3',
    'edaa852ec7e145841d8ffdb056a99866b5f0a478',
  ),
  'large-v3-turbo': model(
    'large-v3-turbo',
    'dropbox-dash/faster-whisper-large-v3-turbo',
    '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf',
    ['mobiuslabsgmbh/faster-whisper-large-v3-turbo'],
  ),
});

export const SPEECH_MODEL_IDS = Object.freeze(Object.keys(SPEECH_MODEL_CATALOG));

export function speechModel(modelId) {
  return SPEECH_MODEL_CATALOG[modelId] || null;
}

export function isSpeechModelId(modelId) {
  return Object.hasOwn(SPEECH_MODEL_CATALOG, modelId);
}
