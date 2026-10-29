import { machine } from './common.mjs';

export default machine('debug', [
  'repro', 'diagnose', 'build', 'verify', 'review', 'recheck', 'browser', 'gate_accept',
]);
