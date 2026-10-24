import { machine } from './common.mjs';

export default machine('small', ['build', 'verify', 'review', 'recheck', 'browser', 'gate_accept']);
