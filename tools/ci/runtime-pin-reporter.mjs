import path from 'node:path';

/**
 * Сохраняет терминальные события точного тестового файла. Наличие директивы
 * записывается отдельно от значения, включая пустую строку.
 */
export default async function* runtimePinReporter(events) {
  yield* reportRuntimePinEvents(events, process.env.GRIGDESK_RUNTIME_PIN_TEST_FILE);
}

/**
 * Maps the raw node:test stream while preserving the presence of directives.
 * A pass from an unrelated file is an explicit error for the downstream collector.
 */
export async function* reportRuntimePinEvents(events, expected) {

  for await (const event of events) {
    if (!['test:pass', 'test:fail'].includes(event.type)) {
      continue;
    }

    const data = event.data;
    const located = typeof data.file === 'string' && path.resolve(data.file) === expected;
    const wrapper = typeof data.name === 'string' && path.resolve(data.name) === expected;

    if (located || wrapper) {
      yield JSON.stringify({
        type: event.type,
        name: data.name,
        nesting: data.nesting,
        directive: ['skip', 'todo', 'expectFailure'].some((key) => Object.hasOwn(data, key)),
        wrapper,
      }) + '\n';
    } else {
      yield JSON.stringify({ type: 'foreign-event' }) + '\n';
    }
  }
}
