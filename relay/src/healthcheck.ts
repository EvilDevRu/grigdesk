import { checkHealth } from './runtime.ts';

process.exitCode = await checkHealth(process.env.RELAY_PORT);
