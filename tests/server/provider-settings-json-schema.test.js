import assert from 'node:assert/strict';
import test from 'node:test';

import schema from '../fixtures/executor-settings/synthetic-v1.json' with { type: 'json' };
import types from '../fixtures/executor-settings/types.json' with { type: 'json' };
import { normalizeJsonSchema } from '../../server/src/lib/executorSettings/jsonSchema.ts';
import { validateNativeSetting } from '../../server/src/lib/executorSettings/validation.ts';

test('новый boolean из схемы появляется без ручного списка ключей', () => {
  const fields = normalizeJsonSchema(schema, {
    path: [],
    writeChannel: {
      id: 'overlay',
      scope: 'grigdesk-chats',
      state: 'verified',
    },
    ownership: [],
    base: { enabled: true },
  });

  assert.equal(fields[0]?.kind, 'boolean');
  assert.equal(fields[0]?.writable, true);
  assert.deepEqual(fields[0]?.path, ['enabled']);
  assert.deepEqual(fields[0]?.default, { state: 'known', value: true });
});

test('OpenAPI exclusiveMinimum и nullable следуют dialect; draft-07 boolean закрывает запись', () => {
  const options = {
    path: [],
    ownership: [],
    writeChannel: {
      id: 'fixture',
      scope: 'grigdesk-chats',
      state: 'verified',
    },
  };
  const schema = {
    type: 'object',
    properties: {
      amount: {
        type: 'number',
        minimum: 0,
        exclusiveMinimum: true,
      },
      text: { type: 'string', nullable: true },
    },
  };
  const fields = normalizeJsonSchema(schema, { ...options, dialect: 'openapi-3.0' });

  assert.equal(validateNativeSetting(fields, '["amount"]', 0)?.code, 'invalid_value');
  assert.equal(validateNativeSetting(fields, '["amount"]', 0.5), null);
  assert.equal(validateNativeSetting(fields, '["text"]', null), null);
  assert.equal(normalizeJsonSchema(schema, { ...options, dialect: 'draft-07' })[0].writable, false);
});

test('скаляры и typed enum берут типы, ограничения и явные defaults только из схемы', () => {
  const fields = normalizeJsonSchema(types, {
    path: [],
    writeChannel: {
      id: 'overlay',
      scope: 'grigdesk-chats',
      state: 'verified',
    },
    ownership: [],
  });
  const byKey = Object.fromEntries(fields.map((field) => [field.path[0], field]));

  assert.equal(byKey.count.kind, 'integer');
  assert.equal(byKey.count.constraints.minimum, 0);
  assert.deepEqual(byKey.count.default, { state: 'known', value: 0 });
  assert.equal(byKey.text.kind, 'string');
  assert.deepEqual(byKey.text.default, { state: 'known', value: '' });
  assert.deepEqual(byKey.choice.constraints.enum, ['1', 1, true, null]);
  assert.equal(byKey.choice.kind, 'enum');
  assert.equal(byKey.nullable.constraints.nullable, true);
  assert.deepEqual(byKey.nullable.default, { state: 'known', value: null });
});

test('локальный ref раскрывается с описанием, цикл и внешняя ссылка закрывают только свою ветку', () => {
  const fields = normalizeJsonSchema(
    {
      type: 'object',
      $defs: {
        Count: { type: 'integer', minimum: 0 },
        Cycle: { $ref: '#/$defs/Cycle' },
      },
      properties: {
        count: { $ref: '#/$defs/Count', description: 'Счётчик' },
        cycle: { $ref: '#/$defs/Cycle' },
        external: { $ref: 'https://example.test/schema.json' },
        neighbor: { type: 'boolean' },
      },
    },
    {
      path: [],
      writeChannel: {
        id: 'overlay',
        scope: 'grigdesk-chats',
        state: 'verified',
      },
      ownership: [],
    },
  );

  assert.equal(fields[0].kind, 'integer');
  assert.equal(fields[0].constraints.minimum, 0);
  assert.equal(fields[0].description, 'Счётчик');
  assert.equal(fields[1].writable, false);
  assert.equal(fields[2].writable, false);
  assert.equal(fields[3].writable, true);
});

test('объекты являются группами; managed и неизвестное условие предка закрывают потомков', () => {
  const fields = normalizeJsonSchema(
    {
      type: 'object',
      properties: {
        group: { type: 'object', properties: { 'a.b': { type: 'boolean' } } },
        managed: { type: 'object', properties: { enabled: { type: 'boolean' } } },
        conditional: {
          type: 'object',
          if: { required: ['enabled'] },
          properties: { enabled: { type: 'boolean' } },
        },
        empty: {},
      },
    },
    {
      path: [],
      writeChannel: {
        id: 'overlay',
        scope: 'grigdesk-chats',
        state: 'verified',
      },
      ownership: [
        {
          path: ['managed'],
          owner: 'GrigDesk',
          reason: 'Служебная ветка',
        },
      ],
      base: { group: { 'a.b': false } },
    },
  );

  assert.equal(fields[0].kind, 'object');
  assert.equal(fields[0].writable, false);
  assert.equal(fields[0].children?.[0].writable, true);
  assert.deepEqual(fields[0].children?.[0].path, ['group', 'a.b']);
  assert.equal(fields[1].children?.[0].writable, false);
  assert.equal(fields[2].children?.[0].writable, false);
  assert.equal(fields[3].kind, 'unknown');
});

test('массив примитивов атомарен, сложный или секретный массив не раскрывает значения', () => {
  const fields = normalizeJsonSchema(
    {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string', maxLength: 10 },
          minItems: 0,
          maxItems: 3,
        },
        complex: { type: 'array', items: { type: 'object', properties: { secret: { writeOnly: true } } } },
      },
    },
    {
      path: [],
      writeChannel: {
        id: 'overlay',
        scope: 'grigdesk-chats',
        state: 'verified',
      },
      ownership: [],
      base: { tags: ['a'], complex: [{ secret: 'never-public-sentinel' }] },
    },
  );

  assert.equal(fields[0].kind, 'array');
  assert.equal(fields[0].writable, true);
  assert.equal(fields[0].items?.kind, 'string');
  assert.equal(fields[0].constraints.minItems, 0);
  assert.equal(fields[1].writable, false);

  const slots = fields.map((field) => ({ default: field.default, base: field.base }));

  assert.equal(JSON.stringify(slots).includes('never-public-sentinel'), false);
});

test('nullable union и enum из const доступны, остальные unions и неизвестные constraints закрыты', () => {
  const fields = normalizeJsonSchema(
    {
      type: 'object',
      properties: {
        nullable: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
        enum: { oneOf: [{ const: 'first' }, { const: 'second' }] },
        mixed: { anyOf: [{ type: 'boolean' }, { type: 'string' }] },
        pattern: { type: 'string', pattern: 'secret' },
        unknown: { type: 'boolean', nativeConstraint: true },
        tuple: { type: 'array', prefixItems: [{ type: 'string' }] },
      },
    },
    {
      path: [],
      writeChannel: {
        id: 'overlay',
        scope: 'grigdesk-chats',
        state: 'verified',
      },
      ownership: [],
    },
  );

  assert.equal(fields[0].writable, true);
  assert.equal(fields[0].constraints.nullable, true);
  assert.equal(fields[1].writable, true);
  assert.deepEqual(fields[1].constraints.enum, ['first', 'second']);
  assert.deepEqual(
    fields.slice(2).map((field) => field.writable),
    [false, false, false, false],
  );
});

test('типизированный словарь раскрывает только обнаруженные ключи; схема ограничена по глубине', () => {
  let deep = { type: 'boolean' };

  for (let index = 0; index < 40; index += 1) {
    deep = { type: 'object', properties: { child: deep } };
  }

  const fields = normalizeJsonSchema(
    {
      type: 'object',
      properties: {
        dictionary: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
        deep,
      },
    },
    {
      path: [],
      writeChannel: {
        id: 'overlay',
        scope: 'grigdesk-chats',
        state: 'verified',
      },
      ownership: [],
      base: { dictionary: { 'a.b': 0 } },
    },
  );

  assert.deepEqual(
    fields[0].children?.map((node) => node.path),
    [['dictionary', 'a.b']],
  );

  let current = fields[1];
  let depth = 0;

  while (current.children?.length) {
    depth += 1;
    current = current.children[0];
  }

  assert.equal(depth <= 24, true);
  assert.equal(current.writable, false);
});

test('упрощение union не теряет ограничения констант и пересечение nullable-ветки', () => {
  const fields = normalizeJsonSchema(
    {
      type: 'object',
      properties: {
        choice: { oneOf: [{ const: 'a', not: { const: 'a' } }, { const: 'b' }] },
        amount: { minimum: 0, anyOf: [{ type: 'number', minimum: 10 }, { type: 'null' }] },
        neighbor: { type: 'boolean' },
      },
    },
    {
      path: [],
      ownership: [],
      writeChannel: {
        id: 'fixture',
        scope: 'grigdesk-chats',
        state: 'verified',
      },
    },
  );

  assert.equal(fields[0].writable, false);
  assert.equal(validateNativeSetting(fields, '["amount"]', 5) !== null, true);
  assert.equal(fields[2].writable, true);
});

test('некорректный constraint и неизвестный dialect закрывают запись вместо потери ограничения', () => {
  const schema = {
    type: 'object',
    properties: {
      bad: { type: 'number', minimum: '0' },
      exclusive: { type: 'number', exclusiveMinimum: 0 },
      neighbor: { type: 'boolean' },
    },
  };
  const options = {
    path: [],
    ownership: [],
    writeChannel: {
      id: 'fixture',
      scope: 'grigdesk-chats',
      state: 'verified',
    },
  };
  const fields = normalizeJsonSchema(schema, { ...options, dialect: 'openapi-3.0' });

  assert.equal(fields[0].writable, false);
  assert.equal(fields[1].writable, false);
  assert.equal(fields[2].writable, true);
  assert.equal(normalizeJsonSchema(schema, { ...options, dialect: 'openapi-4.0' })[2].writable, false);
});

test('enum сложных значений и пустой enum не открывают неподдержанный редактор', () => {
  const fields = normalizeJsonSchema(
    {
      type: 'object',
      properties: {
        objectChoice: { enum: [{ enabled: true }] },
        listChoice: { enum: [[true]] },
        empty: { type: 'boolean', enum: [] },
        malformed: { type: 'boolean', enum: 'true' },
        neighbor: { type: 'boolean' },
      },
    },
    {
      path: [],
      ownership: [],
      writeChannel: {
        id: 'fixture',
        scope: 'grigdesk-chats',
        state: 'verified',
      },
    },
  );

  assert.deepEqual(
    fields.map((field) => field.writable),
    [false, false, false, false, true],
  );
  assert.equal(fields[0].kind, 'unknown');
  assert.equal(fields[1].kind, 'unknown');
});
