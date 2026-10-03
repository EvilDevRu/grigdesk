import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface GlmResearchOverlayOptions {
  root: string;
  endpoint: string;
  transport: 'web' | 'acp';
  model?: string;
  document?: string;
  workspaceRoot?: string;
  hooksPath?: string;
  projectDir?: string;
  disableWebRows?: boolean;
  route?: Record<string, unknown>;
  mcpServers?: readonly {
    name: string;
    command: string;
    args: readonly string[];
    env?: Record<string, string>;
  }[];
}

export const GLM_RESEARCH_KEY = 'synthetic-glm-route-key';

/**
 * Исследовательский overlay G2: строки Р5 с loopback-адресом и синтетическим ключом.
 * JSON — подмножество YAML, поэтому overlay пишется без собственного сериализатора.
 */
export async function writeGlmResearchOverlay(options: GlmResearchOverlayOptions): Promise<string> {
  const guard = path.join(options.root, 'glm-loopback-guard.mjs');
  const model = options.model ?? 'glm-5.3';
  const defaultModel = { provider: 'zai', model };

  await fs.mkdir(options.root, { recursive: true, mode: 0o700 });
  await fs.writeFile(guard, [
    'export const name = "cockpit-glm-loopback-guard";',
    'export function apply() {',
    '  const original = globalThis.fetch;',
    '  globalThis.fetch = (input, ...args) => {',
    '    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));',
    '    if (url.hostname !== "127.0.0.1") {',
    '      throw new Error("Стенд GLM допускает только loopback fetch");',
    '    }',
    '    return original(input, ...args);',
    '  };',
    '}',
  ].join('\n') + '\n', { mode: 0o600 });

  const rows: Record<string, unknown>[] = [
    ...(options.document ? [{ id: 'settings', config: { path: options.document } }] : []),
    { id: 'llm-deepseek', disabled: true },
    { id: 'session-title-llm', disabled: true },
    options.transport === 'web'
      ? { id: 'agent-default-model', config: defaultModel }
      : { id: 'acp', config: defaultModel },
    ...(options.disableWebRows
      ? ['web', 'web-search-deepseek', 'web-fetch-http'].map((id) => ({ id, disabled: true }))
      : []),
    ...(options.workspaceRoot ? [
      { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: options.workspaceRoot } },
      { id: 'approval', config: { policy: 'ask' } },
      {
        id: 'permission',
        config: {
          presets: {
            'read-only': { sandbox: 'read-only', approval: 'ask' },
            'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
            'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
          },
          defaultPreset: 'workspace-write',
        },
      },
      { id: 'agent-instructions', config: { maxBytes: 262_144 } },
    ] : []),
    {
      insert: [
        {
          id: 'llm-pi-ai',
          name: '@deepseek-ai/dsh-llm-pi-ai',
          config: {
            providers: {
              zai: {
                apiKeyEnv: 'COCKPIT_GLM_ROUTE_KEY',
                baseURL: options.endpoint,
                retryPolicy: {
                  mode: 'normal',
                  maxRetries: 0,
                },
                ...options.route,
              },
            },
          },
        },
        {
          id: 'cockpit-glm-loopback-guard',
          name: pathToFileURL(guard).href,
        },
        ...(options.hooksPath ? [{
          id: 'hooks-claude-code',
          name: '@deepseek-ai/dsh-hooks-claude-code',
          config: {
            configPath: options.hooksPath,
            projectDir: options.projectDir,
            // Дескриптор вызова исследовательский hook отдаёт через stderr в hook/result.
            stderrSummaryMaxChars: 8000,
          },
        }] : []),
        ...(options.mcpServers ?? []).map((server) => ({
          id: `cockpit-mcp-${server.name}`,
          name: '@deepseek-ai/dsh-mcp-client',
          config: {
            serverName: server.name,
            transport: 'stdio',
            command: server.command,
            args: [...server.args],
            env: server.env ?? {},
          },
        })),
      ],
    },
  ];
  const overlay = path.join(options.root, 'overlay.yml');

  await fs.writeFile(overlay, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });

  return overlay;
}
