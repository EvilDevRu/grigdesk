import { PluginInstallService } from '../../../server/src/lib/pluginInstall/service.ts';

const options = JSON.parse(process.argv[2]);
const service = new PluginInstallService(options);
const result = await service.recover();

await service.close();
await new Promise((resolve, reject) => {
  process.send({ type: 'result', result }, (error) => {
    if (error) {
      reject(error);
    } else {
      resolve();
    }
  });
});
process.disconnect();
