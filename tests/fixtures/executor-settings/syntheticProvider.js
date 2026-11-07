import schema from './synthetic-v1.json' with { type: 'json' };

/**
 * Пятый исполнитель использует реальные общие сервисы GrigDesk.
 * Его schema и приватный payload меняются только через тестовую зависимость.
 */
export function syntheticProvider({ readSchema = () => schema } = {}) {
  let discoveries = 0;

  return {
    id: 'future-provider',
    name: 'Будущий исполнитель',
    bin: () => '/bin/true',
    probe: async () => ({ ok: true, version: '1' }),
    auth: async () => ({
      mode: 'fixture',
      label: 'Тест',
      available: true,
    }),
    settings: [
      {
        id: 'blockDirectSsh',
        kind: 'toggle',
        label: 'SSH',
        value: true,
      },
    ],
    discoveries: () => discoveries,
    nativeSettings: {
      async discover(context) {
        discoveries += 1;

        return {
          context,
          generation: 'fixture',
          source: {
            kind: 'synthetic',
            version: '1',
            checkedAt: 1000,
            coverage: [{ path: [], coverage: 'complete' }],
          },
          areas: [
            {
              path: [],
              format: 'json-schema',
              dialect: '2020-12',
              schema: readSchema(),
              coverage: 'complete',
              writeChannel: {
                id: 'overlay',
                scope: 'grigdesk-chats',
                state: 'verified',
              },
              base: { enabled: true },
            },
          ],
          ownership: [],
        };
      },
      async prepare(context, _snapshot, overrides) {
        return {
          providerId: context.providerId,
          contextFingerprint: '',
          schemaRevision: '',
          storageRevision: '',
          fingerprint: '',
          accepted: overrides,
          payload: Object.fromEntries(overrides.map((entry) => [entry.path[0], entry.value])),
        };
      },
      verify: () => [],
    },
  };
}
