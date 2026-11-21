import { runEntry } from './interactive.ts';

process.exitCode = await runEntry(process.argv.slice(2));
