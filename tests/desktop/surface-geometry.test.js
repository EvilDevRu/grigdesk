import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import {
  cascadeSurfaceBounds,
  fitSurfaceBounds,
  normalizeSurfaceGeometry,
  placeSurfaceBounds,
} from '../../desktop/src/surfaceGeometry.ts';
import { normalizeSettings, readSettings, writeSettings } from '../../desktop/src/settings.ts';
import { temporary } from '../relay/helpers.js';

test('SG-01: геометрия отдельно от main, старый DTO без лишнего поля', () => {
  assert.equal('surfaceWindows' in normalizeSettings(null), false);

  const geometry = {
    x: -1200, 
    y: 30, 
    width: 900, 
    height: 700, 
    maximized: false
  };
  const result = normalizeSettings({
    version: 2, 
    profiles: [], 
    selected: null,
    window: {
      width: 1280, 
      height: 860, 
      maximized: false
    },
    surfaceWindows: { task: geometry },
  });

  assert.deepEqual(result.surfaceWindows.task, geometry);
  assert.equal(result.window.width, 1280);
  assert.equal(normalizeSurfaceGeometry({ ...geometry, x: Infinity }), null);
  assert.equal(normalizeSurfaceGeometry({ ...geometry, width: -1 }), null);
});
test('SG-02: отключённый монитор и уменьшившийся экран не оставляют окно снаружи', () => {
  const area = {
    x: 0, 
    y: 0, 
    width: 800, 
    height: 600
  };
  const saved = {
    x: 2000, 
    y: 100, 
    width: 1000, 
    height: 900, 
    maximized: false
  };

  assert.deepEqual(fitSurfaceBounds(saved, [area]), {
    x: 0, 
    y: 0, 
    width: 800, 
    height: 600,
  });

  const negative = {
    x: -1600, 
    y: 0, 
    width: 1600, 
    height: 900
  };
  const desired = {
    x: -1200, 
    y: 30, 
    width: 900, 
    height: 700, 
    maximized: false
  };

  assert.deepEqual(fitSurfaceBounds(desired, [area, negative]), {
    x: -1200, 
    y: 30, 
    width: 900, 
    height: 700,
  });
});
test('SG-03: новая геометрия переживает настоящую атомарную запись и чтение', async (t) => {
  const root = await temporary(t);
  const file = path.join(root, 'settings.json');
  const geometry = {
    x: 40, 
    y: 50, 
    width: 900, 
    height: 700, 
    maximized: false
  };
  const settings = normalizeSettings({
    version: 2,
    profiles: [],
    selected: null,
    window: {
      width: 1280, 
      height: 860, 
      maximized: false
    },
    surfaceWindows: { task: geometry },
  });

  await writeSettings(file, settings);

  const restored = await readSettings(file);

  assert.deepEqual(restored.surfaceWindows.task, geometry);
  assert.equal(restored.window.width, 1280);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
});

test('SG-05: у края и после maximized новое окно оставляет предыдущее видимым', () => {
  const area = {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
  };
  const cases = [
    {
      x: 920,
      y: 280,
      width: 1000,
      height: 800,
    },
    {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    },
  ];

  for (const previous of cases) {
    const saved = { ...previous, maximized: true };
    const next = placeSurfaceBounds(saved, 1, [area], previous);
    const contains = next.x <= previous.x && next.y <= previous.y
      && next.x + next.width >= previous.x + previous.width
      && next.y + next.height >= previous.y + previous.height;

    assert.equal(next.x !== previous.x || next.y !== previous.y, true);
    assert.equal(contains, false);
    assert.equal(next.x >= area.x && next.y >= area.y, true);
    assert.equal(next.x + next.width <= area.width, true);
    assert.equal(next.y + next.height <= area.height, true);
  }
});
test('SG-04: новое окно смещается лесенкой и остаётся в рабочей области', () => {
  const area = {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
  };
  const saved = {
    x: 100,
    y: 80,
    width: 1000,
    height: 800,
    maximized: false,
  };

  assert.deepEqual(cascadeSurfaceBounds(saved, 0), saved);
  assert.deepEqual(cascadeSurfaceBounds(saved, 2), {
    ...saved,
    x: 164,
    y: 144,
  });
  assert.deepEqual(cascadeSurfaceBounds(saved, 9), {
    ...saved,
    x: 132,
    y: 112,
  });
  assert.deepEqual(fitSurfaceBounds(cascadeSurfaceBounds(saved, 7), [area]), {
    x: 324,
    y: 280,
    width: 1000,
    height: 800,
  });
});

test('TW-G01: отдельная geometry code/shelf/task переживает запись и не теряет соседей', async (t) => {
  const root = await temporary(t);
  const file = path.join(root, 'settings.json');
  const task = {
    x: 10,
    y: 20,
    width: 900,
    height: 700,
    maximized: false


  };
  const code = {
    x: -1600,
    y: 40,
    width: 1500,
    height: 950,
    maximized: false


  };
  const shelf = {
    x: 100,
    y: 80,
    width: 600,
    height: 800,
    maximized: true


  };
  const settings = normalizeSettings({

    version: 2,

    profiles: [],

    selected: null,

    window: {
      width: 1280,
      height: 860,
      maximized: false


    },

    surfaceWindows: { task, tools: { code, shelf } },



  });

  await writeSettings(file, settings);

  const restored = await readSettings(file);

  assert.deepEqual(restored.surfaceWindows.tools, { code, shelf });
  assert.deepEqual(restored.surfaceWindows.task, task);
  restored.surfaceWindows.tools.code = { ...code, width: 1400 };
  await writeSettings(file, restored);

  const updated = await readSettings(file);

  assert.equal(updated.version, 2);
  assert.deepEqual(updated.surfaceWindows.tools.shelf, shelf);
  assert.deepEqual(updated.surfaceWindows.task, task);
  assert.equal(updated.window.width, 1280);
  assert.equal(updated.surfaceWindows.tools.code.width, 1400);
  assert.equal('detached' in updated, false);
  assert.equal('openWindows' in updated, false);
});
