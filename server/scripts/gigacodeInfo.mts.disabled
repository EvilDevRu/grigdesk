import { promises as fs } from 'node:fs';
import { gigaCodeAuth } from '../src/lib/gigacode/auth.ts';
import { gigaCodeCatalog, gigaCodeCatalogCacheKey } from '../src/lib/gigacode/catalog.ts';
import { probeGigaCode } from '../src/lib/gigacode/discovery.ts';
import { gigaCodeFanoutCount, inspectGigaCodeFailure } from '../src/lib/gigacode/failures.ts';

const config = {
  gigacodeBin: process.env.GRIGDESK_GIGACODE_BIN,
  gigacodeHome: process.env.GRIGDESK_GIGACODE_HOME,
  gigacodeRuntimeHome: process.env.GRIGDESK_GIGACODE_RUNTIME_HOME,
  gigacodeBwrapBin: process.env.GRIGDESK_GIGACODE_BWRAP_BIN,
};

try {
  const command = process.argv[2];

  if (command === '--probe') {
    const probe = await probeGigaCode(config);

    if (!probe.ok || !(await gigaCodeAuth(config)).available) {
      process.exitCode = 4;
    } else {
      console.log(probe.version);
    }
  } else if (command === '--fingerprint') {
    if (!(await gigaCodeAuth(config)).available) {
      process.exitCode = 4;
    } else {
      console.log(await gigaCodeCatalogCacheKey(config));
    }
  } else if (command === '--catalog') {
    const models = await gigaCodeCatalog(config);

    if (!models?.length) {
      process.exitCode = 4;
    } else {
      for (const model of models) {
        if (/[\0\r\n\t]/u.test(model.id)) {
          throw new Error('Непредставимый model id в TSV');
        }

        console.log([model.id, 'gigacode', model.family, '1', 'default', '1', '1', '0', '1',
          '*', '*'].join('\t'));
      }
    }
  } else if (command === '--classify' || command === '--fanout') {
    const raw = await fs.readFile(process.argv[3]!, 'utf8').catch(() => '');

    console.log(command === '--classify'
      ? inspectGigaCodeFailure(raw).classification : gigaCodeFanoutCount(raw));
  } else {
    process.exitCode = 4;
  }
} catch {
  process.exitCode = 4;
}
