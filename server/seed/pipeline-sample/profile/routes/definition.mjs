import { readFileSync } from 'node:fs';
import path from 'node:path';

import { profile, promptsFor, routeIds, routesDirectory, single, stop } from './common.mjs';
import small from './small-definition.mjs';
import feature from './feature-definition.mjs';
import debug from './debug-definition.mjs';

export const definitions = Object.fromEntries([small, feature, debug]
  .map((route) => [route.id, {
    route,
    prompts: promptsFor(route),
  }]));
const scout = JSON.parse(readFileSync(path.join(routesDirectory, 'bootstrap/scout.json'), 'utf8'));

export const bootstrap = { ...scout, profile };
export const bootstrapPrompts = {
  'bootstrap/prompts/scout.base.md': readFileSync(
    path.join(routesDirectory, 'bootstrap/prompts/scout.base.md'), 'utf8',
  ),
};

export const catalogFor = (hashes) => ({
  schema: 2,
  profile,
  routes: Object.fromEntries(routeIds.map((id) => [id, hashes[id]])),
  bootstrap: { file: 'bootstrap/scout.json' },
});
