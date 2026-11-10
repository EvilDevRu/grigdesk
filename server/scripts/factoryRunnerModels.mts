import { collectFactoryRunnerModels } from '../src/lib/factoryRunnerModels.ts';

try {
  const [provider, catalog, cli, ...extra] = process.argv.slice(2);

  if (!provider || catalog === undefined || extra.length) {
    throw new Error('metadata_unavailable: требуется исполнитель и каталог раннера');
  }

  console.log(JSON.stringify({
    schema: 1,
    models: await collectFactoryRunnerModels(provider, catalog, cli),
  }));
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 4;
}
