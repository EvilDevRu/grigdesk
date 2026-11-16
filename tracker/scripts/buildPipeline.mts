import path from 'node:path';
import { buildBinary } from './build.mts';
import { parseBuildArgs } from './buildSteps.mts';

const packageDir = path.resolve(import.meta.dirname, '..');
const parsed = parseBuildArgs(process.argv.slice(2), process.cwd(), packageDir);

if ('error' in parsed) {
    process.stderr.write(parsed.error + '\n');
    process.exitCode = 2;
}
else {
    void buildBinary(parsed, 'pipeline').catch((error: unknown) => {
        process.stderr.write('Сборка pipeline не удалась: ' + (error as Error).message + '\n');
        process.exitCode = 1;
    });
}
