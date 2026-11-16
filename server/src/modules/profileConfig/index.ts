import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';

import { PROFILE_RE } from '../../lib/profiles.ts';
import { loadRunnerConfig } from '../../lib/runnerState.ts';
import { ProfileConfigError, readProfileVariables, applyProfileVariableChanges, applyRunnerOperations,
  decodeVariablePatch, decodeRunnerPatch } from '../../lib/profileConfig.ts';
import type { ProfileConfigRuntime } from '../../lib/profileConfig.ts';

export interface ProfileConfigModuleOptions {
  config: ProfileConfigRuntime;
}

interface ProfileParams {
  Params: { profile: string };
  Body: unknown;
}

/**
 * Неизвестная ошибка остаётся серверной, ожидаемые отказы имеют стабильный DTO.
 * Частичный результат CLI — только число подтверждённых предыдущих операций.
 */
function sendError(app: FastifyInstance, reply: FastifyReply, error: unknown): unknown {
  if (error instanceof ProfileConfigError) {
    return reply.code(error.status).send({
      error: error.code,
      message: error.message,
      ...(error.code === 'profile_config_cli' ? {
        appliedOperations: error.applied,
        currentOperationUnknown: error.currentOperationUnknown,
      } : {}),
    });
  }

  app.log.error({ err: error }, 'Ошибка конфигурации профиля');


  return reply.code(500).send({ error: 'profile_config_failed' });
}

/**
 * Возможности — уже существующая декларация graph.json, без запуска профиля.
 * Битая необязательная проекция не превращается в shell-вызов.
 */
async function capabilitiesOf(profilesDir: string, profile: string): Promise<string[]> {
  try {
    const graph = JSON.parse(await fs.readFile(path.join(profilesDir, profile, 'graph.json'), 'utf8'));

    return Array.isArray(graph?.capabilities)
      ? graph.capabilities.filter((item: unknown): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * Имя профиля валидируется до передачи любому файловому reader/writer.
 * Все маршруты остаются под общим auth guard приложения.
 */
export async function registerProfileConfigApi(app: FastifyInstance,
  options: ProfileConfigModuleOptions): Promise<void> {
  app.get<ProfileParams>('/api/profiles/:profile/config', async (request, reply) => {
    try {
      const profile = request.params.profile;

      if (!PROFILE_RE.test(profile)) {
        throw new ProfileConfigError('profile_invalid', 400);
      }

      const profileSh = await readProfileVariables(options.config.profilesDir, profile, 'profile.sh');
      const dashboard = await readProfileVariables(options.config.profilesDir, profile, 'dashboard.env');

      reply.header('cache-control', 'no-store');


      return {
        profile,
        variables: { profileSh, dashboard },
        runners: loadRunnerConfig(options.config.profilesDir, profile),
        capabilities: await capabilitiesOf(options.config.profilesDir, profile),
      };
    } catch (error) {
      return sendError(app, reply, error);
    }
  });
  app.patch<ProfileParams>('/api/profiles/:profile/variables', async (request, reply) => {
    try {
      const profile = request.params.profile;

      if (!PROFILE_RE.test(profile)) {
        throw new ProfileConfigError('profile_invalid', 400);
      }

      const { file, changes } = decodeVariablePatch(request.body);
      const variables = await applyProfileVariableChanges(options.config.profilesDir,
        profile, file, changes);

      reply.header('cache-control', 'no-store');


      return {
        profile,
        file,
        variables
      };
    } catch (error) {
      return sendError(app, reply, error);
    }
  });

  app.patch<ProfileParams>('/api/profiles/:profile/runners', async (request, reply) => {
    try {
      const profile = request.params.profile;

      if (!PROFILE_RE.test(profile)) {
        throw new ProfileConfigError('profile_invalid', 400);
      }

      const operations = decodeRunnerPatch(request.body);
      const runners = await applyRunnerOperations(options.config, profile, operations);

      reply.header('cache-control', 'no-store');


      return { profile, runners };
    } catch (error) {
      return sendError(app, reply, error);
    }
  });

}

export default fp(registerProfileConfigApi, { name: 'module-profile-config' });
