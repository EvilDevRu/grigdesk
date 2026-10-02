import { forkDeepSeekHome } from './deepseekHomeFork.ts';

const args = process.argv.slice(2);

if (args.length !== 6 || args[0] !== '--source-home' || args[2] !== '--destination-home'
    || args[4] !== '--generation') {
  throw new Error('Нужны --source-home <abs> --destination-home <abs> --generation <abs>');
}

console.log(JSON.stringify(await forkDeepSeekHome(args[1]!, args[3]!, args[5]!)));
