import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const systemd = JSON.parse(fs.readFileSync(path.join(root, 'systemd.json'), 'utf8'));
const args = process.argv.slice(2);

if (args[0] === '--version') {
  process.exit(systemd ? 0 : 1);
}

const env = {};
let command;

for (const [index, arg] of args.entries()) {
  if (arg.startsWith('--setenv=')) {
    const pair = arg.slice('--setenv='.length);
    const separator = pair.indexOf('=');

    env[pair.slice(0, separator)] = pair.slice(separator + 1);
  } else if (arg.startsWith('--property=EnvironmentFile=')) {
    const file = arg.slice('--property=EnvironmentFile='.length);

    for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
      const separator = line.indexOf('=');

      env[line.slice(0, separator)] = JSON.parse(line.slice(separator + 1));
    }
  } else if (!arg.startsWith('--')) {
    command = args.slice(index);
    break;
  }
}

const child = spawn(command[0], command.slice(1), {
  env,
  detached: true,
  stdio: 'ignore'
});

child.unref();
