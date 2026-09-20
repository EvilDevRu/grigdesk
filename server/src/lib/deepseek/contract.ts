export const DEEPSEEK_PIN = Object.freeze({
  version: '0.1.5-rc.2',
  integrity: 'sha512-8Xc8hCQHcIWRmTCVU/xZdp6/qMsWMeAd2ObChKDEsfhUPJFXx6H0lgeb1DxUMD86HZrrVN+1bCvn1ppjZ/fOxw==',
});

export const DEEPSEEK_DIALECT = 'deepseek-harness-jsonl-v1';
export const DEEPSEEK_SANDBOX_MODES = Object.freeze([
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const);
export const DEEPSEEK_CHAT_MODES = Object.freeze([
  'default',
  'auto',
  'read-only',
] as const);
export const DEEPSEEK_BASH_TOOL = 'bash';
export const DEEPSEEK_BASH_COMMAND_FIELD = 'command';

export type DeepSeekSandboxMode = typeof DEEPSEEK_SANDBOX_MODES[number];
export type DeepSeekChatMode = typeof DEEPSEEK_CHAT_MODES[number];
