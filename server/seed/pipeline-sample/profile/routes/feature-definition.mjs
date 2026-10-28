import { machine } from './common.mjs';

export default machine('feature', [
  'plan', 'skeptic', 'gate_plan', 'tests', 'build', 'verify', 'browser', 'audit', 'gate_accept',
]);
