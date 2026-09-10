import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG_URL = pathToFileURL(path.join(ROOT, 'server/src/config.ts')).href;

test('по умолчанию сервер использует встроенный engine', async () => {
  const savedHome = process.env.FACTORY_HOME;
  const savedBin = process.env.COCKPIT_FACTORY_BIN;
  const savedProfiles = process.env.FACTORY_PROFILES_DIR;
  delete process.env.FACTORY_HOME;
  delete process.env.COCKPIT_FACTORY_BIN;
  delete process.env.FACTORY_PROFILES_DIR;
  try {
    const { config } = await import(`${CONFIG_URL}?defaults-test=${Date.now()}`);
    assert.equal(config.factoryHome, path.join(ROOT, 'engine'));
    assert.equal(config.factoryBin, path.join(ROOT, 'engine/bin/factory'));
    assert.equal(config.profilesDir, path.join(ROOT, 'profiles'));
  } finally {
    if (savedHome === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = savedHome;
    if (savedBin === undefined) delete process.env.COCKPIT_FACTORY_BIN;
    else process.env.COCKPIT_FACTORY_BIN = savedBin;
    if (savedProfiles === undefined) delete process.env.FACTORY_PROFILES_DIR;
    else process.env.FACTORY_PROFILES_DIR = savedProfiles;
  }
});
