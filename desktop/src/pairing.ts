import https from 'node:https';
import { clientFailureText } from '../../shared/client/clientShell.ts';
import { decodePairing } from '../../shared/client/pairingPayload.ts';
import { API_VERSION } from '../../shared/client/apiVersion.ts';
import type { DeviceIdentity, IdentityStore } from '../../shared/desktop/deviceIdentity.ts';
import { pinnedAgent } from './pipe/upstream.ts';
import { versionFailure } from './pipe/versionGate.ts';
import type { Profiles } from './profiles.ts';

/**
 * Привязка и hello используют тот же TLS-агент, что обычная труба.
 * Ответ ограничен мегабайтом, ошибки не включают секретный запрос или адрес машины.
 */
export async function pinnedJson(options: {
  address: string;
  fp: string;
  identity: DeviceIdentity;
}, pathname: string, body?: unknown): Promise<Record<string, unknown>> {
  const agent = pinnedAgent(options);

  try {
    return await new Promise((resolve, reject) => {
      const request = https.request(new URL(pathname, options.address), {
        agent,
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      }, (response) => {
        const failure = versionFailure(API_VERSION, response.headers['x-grigdesk-api']);
        let text = '';

        response.on('data', (chunk: Buffer) => {
          text += chunk.toString();

          if (text.length > 1024 * 1024) {
            request.destroy(new Error('Ответ машины слишком большой.'));
          }
        });
        response.on('end', () => {
          try {
            const value = JSON.parse(text) as Record<string, unknown>;

            if (failure || response.statusCode !== 200) {
              reject(new Error(clientFailureText(failure || value.error)));
            } else {
              resolve(value);
            }
          } catch {
            reject(new Error('Машина вернула неверный ответ.'));
          }
        });
        response.on('error', reject);
      });

      request.setTimeout(3000, () => request.destroy(new Error('Машина не отвечает.')));
      request.on('error', (error) => reject(new Error(clientFailureText(
        error.message === 'identityMismatch' ? error.message : (error as NodeJS.ErrnoException).code))));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  } finally {
    agent.destroy();
  }
}

/**
 * Одна личность установки переиспользуется при потере ответа и повторе кода.
 * Профиль появляется лишь после pin-проверенного pair и подтверждения hello.
 */
export function createPairing(options: {
  profiles: Profiles;
  identity: IdentityStore;
  directory: string;
}) {
  return {
    /**
     * Код используется только внутри pin-проверенного TLS-запроса.
     * Повтор привязки возвращает тот же публичный профиль.
     */
    async addByPairing(text: string) {
      const payload = decodePairing(text);
      let identity: DeviceIdentity;

      try {
        identity = await options.identity.create(options.directory, 'GrigDesk');
      } catch (error) {
        if ((error as Error).message === 'secure_store_unavailable') {
          throw new Error('Защищённое хранилище ключей недоступно. Разблокируйте связку ключей.');
        }

        throw error;
      }

      const connection = {
        address: `https://${payload.host}:${payload.port}`,
        fp: payload.fp,
        identity,
      };

      await pinnedJson(connection, '/api/client/pair', { code: payload.code });

      const hello = await pinnedJson(connection, '/api/client/hello');

      if (hello.fp !== payload.fp || typeof hello.name !== 'string') {
        throw new Error('Это не тот сервер.');
      }

      return options.profiles.add({
        name: hello.name,
        kind: 'remote',
        address: connection.address,
        fp: payload.fp,
      });
    },
  };
}
