import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { recordOrEmpty } from '../../../../shared/lib/objects.ts';
import { withSettingsStdioProbe } from '../executorSettings/probe.ts';

/**
 * Control initialize читает metadata без пользовательского сообщения и платного model prompt.
 * Свой cwd, запрет hooks и отсутствие persistence не затрагивают проект или чужую историю.
 */
export async function readClaudeFastModels(config: { claudeBin: string }): Promise<Set<string>> {
  let cwd: string | undefined;

  try {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-speed-'));

    return await withSettingsStdioProbe({
      bin: config.claudeBin,
      args: [
        '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--verbose', '--no-session-persistence',
        '--settings', JSON.stringify({ disableAllHooks: true }),
      ],
      cwd,
      signal: AbortSignal.timeout(5_000),
    }, async (probe) => {
      const value = await probe.request({
        type: 'control_request',
        request_id: 'speed-init',
        request: { subtype: 'initialize' },
      }, (event) => event.type === 'control_response'
        && recordOrEmpty(event.response).request_id === 'speed-init');
      const response = recordOrEmpty(value.response);

      if (response.subtype !== 'success') {
        throw new Error('Claude не подтвердил каталог скоростей');
      }

      const models = recordOrEmpty(response.response).models;
      const allowed = new Set<string>();

      for (const value of Array.isArray(models) ? models : []) {
        const model = recordOrEmpty(value);

        const id = typeof model.resolvedModel === 'string' ? model.resolvedModel : model.value;

        if (model.supportsFastMode === true && typeof id === 'string') {
          allowed.add(id);
        }
      }

      return allowed;
    });
  } catch {
    return new Set();
  } finally {
    if (cwd) {
      await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }
}
