import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectModel } from '../../server/src/modules/studio3d/formats.ts';

/**
 * Контейнеры проверяются в своей папке, ни сети, ни production library нет.
 * Каждый сценарий возвращает путь файла и удаляет только свою временную папку.
 */
async function file(t, name, bytes) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-formats-'));
  const target = path.join(root, name);

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(target, bytes);

  return { root, target };
}

export const ASCII_FBX = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
  FBXHeaderVersion: 1003
  FBXVersion: 7400
}
Objects:  {
  Geometry: 1, "Geometry::Fixture", "Mesh" {
    Vertices: *9 { a: 0,0,0,1,0,0,0,1,0 }
    PolygonVertexIndex: *3 { a: 0,1,-3 }
  }
  Model: 2, "Model::Fixture", "Mesh" { Version: 232 }
}
Connections:  {
  C: "OO",1,2
  C: "OO",2,0
}
`;

test('AP-16 OBJ без завершающего newline валиден, неверные face индексы отвергаются', async (t) => {
  const input = await file(t, 'mesh.obj', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3');

  assert.equal(await inspectModel(input.root, input.target), null);
  await fs.writeFile(input.target, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 999 2 3\n');
  await assert.rejects(inspectModel(input.root, input.target), { statusCode: 415 });
});

test('AP-16 binary STL проверяет все треугольники, NaN не проходит по длине', async (t) => {
  const bytes = Buffer.alloc(184);

  bytes.writeUInt32LE(2, 80);
  
  const input = await file(t, 'mesh.stl', bytes);

  assert.equal(await inspectModel(input.root, input.target), null);
  bytes.writeFloatLE(NaN, 138);
  await fs.writeFile(input.target, bytes);
  await assert.rejects(inspectModel(input.root, input.target), { statusCode: 415 });
});

test('AP-16 splat проверяет каждую запись, а не только первые координаты', async (t) => {
  const bytes = Buffer.alloc(64);
  const input = await file(t, 'cloud.splat', bytes);

  assert.equal(await inspectModel(input.root, input.target), null);
  bytes.writeFloatLE(Infinity, 32);
  await fs.writeFile(input.target, bytes);
  await assert.rejects(inspectModel(input.root, input.target), { statusCode: 415 });
});

test('AP-16 ASCII FBX поддержан, повреждённая binary node и external texture отклонены', async (t) => {
  const input = await file(t, 'mesh.fbx', ASCII_FBX);

  assert.equal(await inspectModel(input.root, input.target), null);
  await fs.writeFile(input.target, ASCII_FBX.replace('\n}\nConnections',
    '\n  Video: 3, "Video::Fixture", "Clip" {\n    RelativeFilename: "remote.png"\n  }\n}\nConnections'));
  await assert.rejects(inspectModel(input.root, input.target), { statusCode: 415 });

  const damaged = Buffer.alloc(100);

  damaged.write('Kaydara FBX Binary  \x00\x1a\x00', 0, 'ascii');
  damaged.writeUInt32LE(7400, 23);
  damaged.writeUInt32LE(29, 27);
  await fs.writeFile(input.target, damaged);
  await assert.rejects(inspectModel(input.root, input.target), { statusCode: 415 });
});
