import assert from 'node:assert/strict';
import test from 'node:test';

import { START_CONTEXT } from '../../server/src/lib/studio3d/provider.ts';
import {
  MODEL_H,
  MODEL_P1,
  MODEL_P2,
  RIG_V1,
  RIG_V2,
  TEXTURE_V35,
  nativeAccepts,
  parseTripoTask,
  parseUsage,
  recognizeTripoRecord,
  tripoOperations,
  tripoPool,
  tripoQuote,
  tripoRequestError,
  tripoRequests,
  tripoTaskError,
  tripoValidate,
} from '../../server/src/lib/tripo/catalog.ts';

const TASK = '00000000-0000-4000-8000-000000000001';
const RIG_TASK = '00000000-0000-4000-8000-000000000002';

/**
 * Контекст входной версии поверх пустого: тесты меняют только нужные поля.
 * Так видно, от чего именно зависит ответ каталога.
 */
function context(patch = {}) {
  return {
    ...START_CONTEXT,
    ...patch
  };
}

// Итог проверки и цены одной строкой: так сценарии читаются как прайс.
function priced(operation, raw, ctx = context()) {
  const validation = tripoValidate(operation, raw, ctx);

  return {
    validation,
    quote: tripoQuote(operation, validation.values, ctx)
  };
}

test('TO-01 поля и default варианты действующего каталога согласованы', () => {
  for (const entry of tripoOperations(context({ kind: 'parts' }))) {
    const ids = entry.fields.map((field) => field.id);

    assert.equal(new Set(ids).size, ids.length, entry.operation);

    for (const field of entry.fields.filter((item) => item.kind === 'select' && item.default)) {
      const known = field.options.some((option) => option.value === field.default);

      assert.ok(known, `${entry.operation}.${field.id}`);
    }
  }
});

test('TO-02 цена генерации складывается из базы и надбавок прайса', () => {
  assert.equal(priced('image-to-model', {}).quote.total, 30);
  assert.equal(priced('text-to-model', {
    prompt: 'кот',
    texture: false
  }).quote.total, 10);
  assert.equal(priced('views-to-model', {
    model: MODEL_P1,
    texture_quality: 'detailed'
  }, context({ views: ['front', 'back'] })).quote.total, 60);
  assert.equal(priced('image-to-model', {
    model: MODEL_P2,
    texture_quality: 'extreme'
  }).quote.total, 130);

  const extras = priced('image-to-model', {
    geometry_quality: 'detailed',
    quad: true,
    smart_low_poly: true
  });

  assert.equal(extras.quote.total, 65);
  assert.deepEqual(extras.quote.lines.map((line) => line.label), [
    'Модель из картинки · Детальная — v3.1',
    'Текстура',
    'Форма Ultra',
    'Четырёхугольная сетка',
    'Low-poly «как руками»',
  ]);
  assert.equal(extras.quote.usd, 0.65);
});

test('TO-03 проверки генерации: грани по модели, части, быстрая текстура, вид спереди', () => {
  const p1 = tripoValidate('image-to-model', {
    model: MODEL_P1,
    face_limit: 30,
    quad: true
  }, context());
  const parts = tripoValidate('image-to-model', { generate_parts: true }, context());
  const conflict = tripoValidate('image-to-model', {
    generate_parts: true,
    smart_low_poly: true
  }, context());
  const fast = tripoValidate('image-to-model', { texture_quality: 'fast' }, context());
  const fastOk = tripoValidate('image-to-model', {
    texture_quality: 'fast',
    texture_version: TEXTURE_V35
  }, context());
  const views = tripoValidate('views-to-model', {}, context({ views: ['back', 'left'] }));

  assert.deepEqual(p1.errors.map((issue) => issue.field), ['face_limit']);
  assert.equal('quad' in p1.values, false);
  assert.equal(parts.values.texture, false);
  assert.equal(parts.warnings[0].field, 'texture');
  assert.equal(priced('image-to-model', { generate_parts: true }).quote.total, 40);
  assert.ok(conflict.errors.some((issue) => issue.field === 'generate_parts'));
  assert.ok(fast.errors.some((issue) => issue.field === 'texture_quality'));
  assert.deepEqual(fastOk.errors, []);
  assert.equal(views.errors[0].message, 'Нужен вид спереди и хотя бы ещё один вид.');
});

test('TO-04 картинки: цена по модели и качеству GPT, правке нужен текст или шаблон', () => {
  assert.equal(priced('text-to-image', { prompt: 'кот' }).quote.total, 5);
  assert.equal(priced('text-to-image', {
    prompt: 'кот',
    model: 'gemini-3-pro'
  }).quote.total, 15);
  assert.equal(priced('text-to-image', {
    prompt: 'кот',
    model: 'chat_image_2',
    quality: 'high'
  }).quote.total, 25);
  assert.ok(tripoValidate('text-to-image', {
    prompt: 'кот',
    model: 'chat_image_2',
    quality: 'max'
  }, context()).errors.some((issue) => issue.field === 'quality'));
  assert.equal(tripoValidate('image-edit', {}, context({ kind: 'image' })).errors[0].field, 'prompt');

  const template = tripoValidate('image-edit', { template: 't_pose' }, context({ kind: 'image' }));

  assert.deepEqual(template.errors, []);
});

test('TO-05 экспорт: простой 5, сложный 10, квады не в GLB, скелет только у скелета', () => {
  const model = context({ kind: 'model' });
  const rigged = context({ kind: 'rigged' });

  assert.equal(priced('export', { format: 'FBX' }, model).quote.total, 5);
  assert.equal(priced('export', {
    format: 'GLTF',
    texture_size: '2048'
  }, model).quote.total, 10);
  assert.ok(tripoValidate('export', {
    format: 'FBX',
    quad: true
  }, model).errors.length === 0);
  assert.equal('quad' in tripoValidate('export', {
    format: 'GLTF',
    quad: true
  }, model).values, false);

  const fields = (ctx) => {
    return tripoOperations(ctx).find((entry) => entry.operation === 'export').fields.map((f) => f.id);
  };

  assert.ok(fields(rigged).includes('with_animation'));
  assert.ok(!fields(model).includes('with_animation'));
});

test('TO-06 меньше полигонов: способы, цены и диапазоны граней', () => {
  const model = context({ kind: 'model' });

  assert.equal(priced('retopology', {}, model).quote.total, 30);
  assert.equal(priced('retopology', { model: 'v3.0' }, model).quote.total, 35);
  assert.equal(priced('retopology', {
    model: 'v3.0',
    quad: true
  }, model).quote.total, 40);
  assert.equal(priced('retopology', {
    model: 'v1.0',
    face_limit: 100000
  }, model).quote.total, 10);

  const v1 = tripoValidate('retopology', { model: 'v1.0' }, model);

  assert.ok(v1.errors.some((issue) => issue.field === 'face_limit'));
  assert.ok(tripoValidate('retopology', { face_limit: 30000 }, model).errors.length === 1);
  assert.equal('bake' in tripoValidate('retopology', {
    model: 'v1.0',
    face_limit: 9000
  }, model).values, false);
});

test('TO-07 скелет: умолчания из проверки, человеческий скелет только двуногим', () => {
  const quadruped = context({
    kind: 'model',
    format: 'glb',
    rigCheck: {
      riggable: true,
      rigType: 'quadruped'
    }
  });
  const fields = tripoOperations(quadruped).find((entry) => entry.operation === 'rig').fields;
  const avian = tripoValidate('rig', {
    model: RIG_V1,
    rig_type: 'avian'
  }, quadruped);

  assert.equal(fields.find((field) => field.id === 'model').default, RIG_V2);
  assert.equal(fields.find((field) => field.id === 'rig_type').default, 'quadruped');
  assert.equal(avian.errors[0].field, 'model');
  assert.equal(priced('rig', {}, quadruped).quote.total, 25);
  assert.ok(tripoValidate('rig-check', {}, context({
    kind: 'model',
    format: 'fbx'
  })).errors.length === 1);
});

test('TO-08 движения: набор по скелету, заказ на каждое движение, цена за штуку', () => {
  const human = context({
    kind: 'rigged',
    params: { model: RIG_V1 },
    nativeTaskType: 'animate_rig'
  });
  const dog = context({
    kind: 'rigged',
    params: {
      model: RIG_V2,
      rig_type: 'quadruped'
    }
  });
  const motionsOf = (ctx) => {
    return tripoOperations(ctx).find((entry) => entry.operation === 'animate').fields[0].options;
  };
  const validation = tripoValidate('animate', {
    animations: ['preset:biped:walk', 'preset:biped:run']
  }, human);
  const requests = tripoRequests('animate', validation.values, { primary: RIG_TASK }, human);

  assert.equal(motionsOf(human).length, 101);
  assert.equal(motionsOf(dog).length, 12);
  assert.equal(tripoQuote('animate', validation.values, human).total, 20);
  assert.deepEqual(requests.map((request) => [request.body.animation, request.label, request.body.input]), [
    ['preset:biped:walk', 'Ходьба', RIG_TASK],
    ['preset:biped:run', 'Бег', RIG_TASK],
  ]);
  assert.equal('animations' in requests[0].body, false);
  assert.ok(tripoValidate('animate', {
    animations: motionsOf(human).slice(0, 11).map((m) => m.value)
  }, human).errors.length === 1);
});

test('TO-09 тела запросов: пустое и скрытое не уходит, входы по правилам ручки', () => {
  const text = tripoRequests('text-to-model', tripoValidate('text-to-model', {
    prompt: 'кот',
    compress: true,
    face_limit: ''
  }, context()).values, {}, context())[0];
  const views = tripoRequests('views-to-model', tripoValidate('views-to-model', {}, context({
    views: ['front', 'back']
  })).values, {
    views: {
      back: 'file_b',
      front: 'file_f'
    }
  }, context())[0];
  const fromTask = tripoRequests('views-to-model', {}, { viewsTask: TASK }, context())[0];
  const segment = tripoRequests('smart-segment', {}, { primary: 'file_glb' }, context({ kind: 'model' }))[0];
  const segmentImage = tripoRequests('smart-segment', {}, { primary: 'file_png' }, context({
    kind: 'image'
  }))[0];
  const uv = tripoRequests('uv-unwrap', { bake: true }, { primary: TASK }, context({ kind: 'model' }))[0];
  const transparent = tripoRequests('text-to-image', {
    prompt: 'кот',
    model: 'chat_image_2.5_flare',
    background: 'transparent'
  }, {}, context())[0];

  assert.equal(text.endpoint, '/v3/generation/text-to-model');
  assert.equal(text.body.compress, 'geometry');
  assert.equal('face_limit' in text.body, false);
  assert.equal(text.body.model, MODEL_H);
  assert.deepEqual(views.body.inputs, [{ front: 'file_f' }, { back: 'file_b' }]);
  assert.deepEqual(fromTask.body.inputs, [{ task_id: TASK }]);
  assert.equal(segment.body.seg_type, 'model');
  assert.equal(segment.body.transform.length, 16);
  assert.equal(segment.taskType, 'smartsegment_model');
  assert.equal(uv.body.model, 'default');
  assert.equal(transparent.body.output_format, 'png');
  assert.deepEqual(segment.body, {
    input: 'file_glb',
    seg_type: 'model',
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  });
  assert.deepEqual(segmentImage.body, {
    input: 'file_png',
    seg_type: 'image'
  });
  assert.equal(segmentImage.taskType, 'smartsegment_image');
});

test('TO-10 разбор задачи: роли файлов, остаток времени, ошибки, мусор', () => {
  const done = parseTripoTask({
    task_id: TASK,
    type: 'image_to_model',
    status: 'success',
    progress: 99,
    output: {
      model_url: 'https://cdn.example.test/a/pbr_model.glb?auth_key=1',
      rendered_image_url: 'https://cdn.example.test/a/preview.webp'
    },
    credits_consumed: 30,
  });
  const running = parseTripoTask({
    task_id: TASK,
    status: 'running',
    progress: 140,
    output: { running_left_time: 12 }
  });
  const failed = parseTripoTask({
    task_id: TASK,
    status: 'failed',
    error_code: 2018,
    error_message: 'timeout\u0000x'
  });

  const roles = done.outputs.map((output) => [output.role, output.ext]);

  assert.deepEqual(roles, [['model', 'glb'], ['preview', 'webp']]);
  assert.equal(done.progress, 100);
  assert.equal(done.cost, 30);
  assert.equal(running.progress, 100);
  assert.equal(running.etaSeconds, 12);
  assert.equal(failed.error.kind, 'complex');
  assert.equal(failed.error.detail, 'timeout x');
  assert.equal(parseTripoTask({
    task_id: TASK,
    status: 'weird'
  }).state, 'unknown');
  assert.equal(parseTripoTask({ status: 'success' }), null);
  assert.equal(running.cost, null);
  assert.equal(parseTripoTask({
    task_id: TASK,
    status: 'success',
    credits_consumed: '30'
  }).cost, null);
});

test('TO-11 ошибки запросов и задач называют причину и возврат кредитов', () => {
  assert.equal(tripoRequestError(401, 1002, null).kind, 'auth');

  const busy = tripoRequestError(429, 2000, null, 5000);

  assert.deepEqual([busy.kind, busy.retryAfterMs], ['busy', 5000]);
  assert.equal(tripoRequestError(403, 2010, null).kind, 'credits');
  assert.equal(tripoRequestError(400, 1004, 'invalid model').detail, 'invalid model');
  assert.equal(tripoRequestError(502, null, null).kind, 'server');
  assert.match(tripoTaskError('banned', null, null).message, /Кредиты вернулись/);
  assert.equal(tripoTaskError('failed', 1001, null).kind, 'server');
});

test('TO-12 записи на диске и история трат', () => {
  const cli = recognizeTripoRecord({
    task_id: TASK,
    type: 'multiview_to_model',
    status: 'success',
    input: { model: MODEL_H },
    output_fields: ['model_url'],
    credits_consumed: 30,
    created_at: '2026-10-07T10:00:00Z',
  });
  const raw = recognizeTripoRecord({
    task_id: RIG_TASK,
    type: 'animate_rig',
    status: 'success',
    input: { input: TASK },
    output: {},
  });

  assert.equal(cli.credits, 30);
  assert.equal(raw.inputTaskId, TASK);
  assert.equal(recognizeTripoRecord({
    id: 'x',
    format: 'motion'
  }), null);
  assert.equal(recognizeTripoRecord({
    task_id: TASK,
    type: 'not_a_tripo_type'
  }), null);
  assert.deepEqual(parseUsage([{
    task_id: TASK,
    type: 'text_to_model',
    credits_consumed: 20,
    created_at: '2026-10-07'
  }, { junk: true }, null]), [{
    taskId: TASK,
    type: 'text_to_model',
    credits: 20,
    createdAt: '2026-10-07'
  }]);
});

test('TO-13 номер задачи вместо файла — только там, где ручка его примет', () => {
  assert.equal(nativeAccepts('animate', 'animate_rig'), true);
  assert.equal(nativeAccepts('animate', 'text_to_model'), false);
  assert.equal(nativeAccepts('rig', 'multiview_to_model'), true);
  assert.equal(nativeAccepts('rig', 'animate_prerigcheck'), false);
  assert.equal(nativeAccepts('smart-segment', 'text_to_model'), false);
  assert.equal(nativeAccepts('views-to-model', 'generate_multiview_image'), true);
  assert.equal(nativeAccepts('rig', null), false);
});

test('TO-14 пулы очереди: картинки строго по одной', () => {
  assert.deepEqual(tripoPool('text-to-image', {}), {
    key: 'image',
    limit: 1
  });
  assert.equal(tripoPool('image-to-model', { model: MODEL_P1 }).key, 'generation-p');
  assert.equal(tripoPool('rig', {}).key, 'animation');
});

test('FIX-06 основные результаты выбираются по контракту типа, не первому URL', () => {
  const results = [
    ['text_to_image', { image_url: 'https://cdn.example.test/image.png' }, 'image'],
    ['generate_image', { image_url: 'https://cdn.example.test/edited.webp' }, 'image'],
    ['image_to_splat', { model_url: 'https://cdn.example.test/cloud.splat' }, 'model'],
    ['convert_model', { model_url: 'https://cdn.example.test/converted.fbx' }, 'file'],
    ['animate_rig', { model_url: 'https://cdn.example.test/rig.glb' }, 'model'],
    ['animate_retarget', { model_url: 'https://cdn.example.test/walk.glb' }, 'model'],
  ];

  for (const [type, output, role] of results) {
    const task = parseTripoTask({
      task_id: TASK,
      type,
      status: 'success',
      output
    });
    const main = task.outputs.find((file) => file.id === task.mainFileId);

    assert.equal(main?.role, role, type);
    assert.equal(task.requiredRoles.includes(role), true, type);
  }

  const previewOnly = parseTripoTask({
    task_id: TASK,
    type: 'text_to_model',
    status: 'success',
    output: { rendered_image_url: 'https://cdn.example.test/preview.webp' }
  });

  assert.equal(previewOnly.mainFileId, null);
  assert.deepEqual(previewOnly.requiredRoles, ['model']);
});

test('FIX-06 отдельные URL имеют устойчивые ID, экспорт не угадывает первый ассет', () => {
  const task = parseTripoTask({
    task_id: TASK,
    type: 'convert_model',
    status: 'success',
    output: {
      rendered_image_url: 'https://cdn.example.test/preview.png',
      model_url: 'https://cdn.example.test/model.fbx',
      companion_url: 'https://cdn.example.test/material.zip'
    }
  });
  const reverse = parseTripoTask({
    task_id: TASK,
    type: 'convert_model',
    status: 'success',
    output: {
      companion_url: 'https://cdn.example.test/material.zip',
      model_url: 'https://cdn.example.test/model.fbx',
      rendered_image_url: 'https://cdn.example.test/preview.png'
    }
  });

  assert.equal(task.outputs.find((file) => file.id === task.mainFileId).ext, 'fbx');
  assert.equal(task.mainFileId, reverse.mainFileId);
  assert.equal(new Set(task.outputs.map((file) => file.id)).size, task.outputs.length);
});

test('FIX-06 raw envelope проверяется, а record сохраняет скелет и rig-check', () => {
  const rig = recognizeTripoRecord({
    code: 0,
    data: {
      task_id: RIG_TASK,
      type: 'animate_rig',
      status: 'success',
      input: {
        input: TASK,
        model: RIG_V2,
        rig_type: 'quadruped'
      },
      output: { model_url: 'https://cdn.example.test/rig.glb' }
    }
  });
  const check = recognizeTripoRecord({
    task_id: RIG_TASK,
    type: 'animate_prerigcheck',
    status: 'success',
    input: { input: TASK },
    output: { riggable: true, rig_type: 'biped' }
  });

  assert.equal(rig.params.model, RIG_V2);
  assert.equal(rig.params.rig_type, 'quadruped');
  assert.equal(rig.status, 'success');
  assert.equal(check.rigResult.riggable, true);
  assert.equal(check.rigResult.rigType, 'biped');
  assert.equal(recognizeTripoRecord({ code: 4000, data: rig }), null);
});

test('FIX-05 движения без достоверного скелета не получают human/v1', () => {
  const unknownRig = tripoOperations(context({ kind: 'rigged', params: null }))
    .find((entry) => entry.operation === 'animate');

  assert.deepEqual(unknownRig.fields[0].options, []);
});

test('FIX-07 неизвестная модель не получает нулевую или чужую цену', () => {
  assert.equal(tripoQuote('text-to-image', { model: 'unknown-provider-model' }, context()).total, null);
  assert.equal(tripoQuote('text-to-model', { model: 'unknown-provider-model' }, context()).total, null);
});

test('FIX-06 документированный multiview сохраняет роли и маску полученных видов', () => {
  const task = parseTripoTask({
    task_id: TASK,
    type: 'generate_multiview_image',
    status: 'success',
    output: {
      front_view_url: 'https://cdn.example.test/front.png',
      back_view_url: 'https://cdn.example.test/back.png'
    }
  });

  assert.deepEqual(task.outputs.map((file) => file.role).sort(), ['back', 'front']);
  assert.deepEqual(task.views, ['front', 'back']);
  assert.deepEqual(task.requiredRoles, ['front', 'back']);
  assert.equal(task.mainFileId, null);
});

test('FIX-06 модельные task types объявляют обязательную модель даже без URL', () => {
  const types = [
    'text_to_model', 'image_to_model', 'multiview_to_model', 'refine_model',
    'texture_model', 'stylize_model', 'import_model', 'highpoly_to_lowpoly',
    'mesh_segmentation', 'mesh_completion', 'mesh_uv', 'smartsegment_model',
    'smartsegment_image', 'animate_rig', 'animate_retarget', 'image_to_splat'
  ];

  for (const type of types) {
    const task = parseTripoTask({
      task_id: TASK,
      type,
      status: 'success',
      output: {}
    });

    assert.deepEqual(task.requiredRoles, ['model'], type);
    assert.equal(task.mainFileId, null, type);
  }
});
