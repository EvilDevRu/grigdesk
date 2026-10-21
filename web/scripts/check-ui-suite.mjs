#!/usr/bin/env node

import { checkI18n } from './check-i18n.mjs';
import { checkNativeTitles } from './check-native-titles.mjs';
import { checkUiBoundary } from './check-ui-boundary.mjs';
import { checkUiDependencyBoundary } from './check-ui-dependency-boundary.mjs';
import { checkUiFileNaming } from './check-ui-file-naming.mjs';
import { checkUiGalleryBoundary } from './check-ui-gallery-boundary.mjs';
import { checkUiStyleInjection } from './check-ui-style-injection.mjs';

const checks = [
  ['interface language', checkI18n],
  ['native/structural boundary', checkUiBoundary],
  ['dependency boundary', checkUiDependencyBoundary],
  ['file naming', checkUiFileNaming],
  ['gallery boundary', checkUiGalleryBoundary],
  ['style injection boundary', checkUiStyleInjection],
  ['native title', checkNativeTitles],
];

/**
 * Один npm guard запускает все UI-границы, чтобы локальный и CI-прогон не забывали
 * менее заметные проверки gallery, private imports, имён или runtime CSS injection.
 */
function main() {
  const errors = [];

  for (const [label, check] of checks) {
    const result = check();

    if (result.errors.length === 0) {
      process.stdout.write(`UI ${label}: OK\n`);

      continue;
    }

    errors.push(...result.errors.map((error) => `${label}: ${error}`));
  }

  if (errors.length > 0) {
    process.stderr.write(`UI guard suite нарушен:\n- ${errors.join('\n- ')}\n`);
    process.exitCode = 1;
  }
}

main();
