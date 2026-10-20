// Metadata double DSH ELF с допуском GLM Обычного API для offline-контракта раннера движка.
// Ход модели этот double не выполняет: настоящие web-ходы GLM проверяются на собранном ELF.
import { glmCompatibilityIdentity } from '../../../server/src/lib/glm/contract.ts';
import type { GlmCompatibilityRuntime } from '../../../server/src/lib/glm/contract.ts';
import { runtimeInfoFixture } from '../../helpers/deepseekMetadataFixture.mts';

const args = process.argv.slice(2);
const info = runtimeInfoFixture();

// Другой packageId изображает замену ELF между preflight и запуском этапа. Аргумент, а не env:
// metadata probe сервера запускает binary с закрытым окружением.
const packageAt = args.indexOf('--fixture-package-id');

if (packageAt >= 0) {
  info.packageId = args[packageAt + 1]!;
}

// Fixture всегда несёт llmPiAi, поэтому входы удовлетворяют полному контракту допуска.
const inputs = info.glm.inputs as GlmCompatibilityRuntime;

info.glm.admission = [{ mode: 'api', compatibility: glmCompatibilityIdentity(inputs, 'api') }];

if (args.includes('--runtime-info')) {
  process.stdout.write(`${JSON.stringify(info)}\n`);
  process.exit(0);
}

process.stderr.write('fakeGlmBinary: поддерживается только --runtime-info\n');
process.exit(97);
