import { randomUUID } from 'node:crypto';

import { FactoryStateAdapter } from '../../adapters/factoryState.ts';
import { RoutesStore } from '../../modules/routes/store.ts';
import { buildRouteDef, type RouteMachine } from '../routeGraph.ts';
import { graphForRoute, loadGraph } from '../factoryGraph.ts';
import { loadRunnerConfig, resolveRunnerState } from '../runnerState.ts';
import type { RouteConfig } from '../factoryRouteCli.ts';
import type { AccessProfileService } from './service.ts';

/**
 * Исполнители берутся из эффективных цепочек агентных этапов, включая резервы.
 * Закреплённая попытка использует свой граф; новый start — проверяемый каталог запуска.
 */
export async function routeProviders(config: RouteConfig, task: string, args: string[]): Promise<string[]> {
  const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] ?? '' : '';
  const profile = value('--profile');
  const factory = new FactoryStateAdapter({
    stateDir: config.stateDir,
    profilesDir: config.profilesDir,
    routesDir: config.routesDir,
    controlDir: config.factoryControlDir,
  });
  const registry = value('--attempt') ? (await factory.readRegistry(task)).registry : {};
  let graph;

  if (value('--attempt')) {
    await factory.readTrustedAttempt(task, registry);
    graph = await factory.routeDef(registry);
  } else {
    const store = new RoutesStore({ baseDir: config.routesDir });
    const hash = value('--expected-catalog-hash');
    const catalog = hash ? await store.readCatalog(profile, hash).catch(() => null) : null;

    if (catalog) {
      const routeId = value('--route');
      const route = await store.readRoute(profile, routeId, catalog.catalog.routes[routeId]!);

      graph = buildRouteDef(route.route as RouteMachine, routeId, {
        bootstrap: catalog.bootstrap as RouteMachine,
      });
    } else {
      graph = graphForRoute(loadGraph(config.profilesDir, profile), value('--route'));
    }
  }

  if (value('--runner-primary')) {
    registry.RUNNER_OVERRIDE_PRIMARY = value('--runner-primary');
  }

  const policy = loadRunnerConfig(config.profilesDir, profile);
  const providers = Object.entries(graph.nodes).flatMap(([node, definition]) => {
    if (definition[0] !== 'agent') {
      return [];
    }

    const stage = graph.runnerKeys[node] ?? graph.keys[node] ?? node.toUpperCase();

    return resolveRunnerState(policy, registry, stage).chain;
  });

  return [...new Set([...providers, ...value('--runner-primary').split(',')].filter(Boolean))].sort();
}

/**
 * До spawn каждый участник получает durable pin в стабильном порядке блокировок.
 * Отказ подготовки снимает только новые pins этого dispatch, прежние попытки сохраняются.
 */
export async function preparePipelineAccess(service: AccessProfileService, config: RouteConfig,
  task: string, args: string[], explicit?: string[]) {
  const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] ?? '' : '';
  const attempt = value('--attempt') || null;
  const launchId = value('--queue-dispatch-id') || randomUUID();
  const selected = explicit ?? await routeProviders(config, task, args);
  const adapters = await service.adaptersOf();
  const providers = [...new Set([...selected, ...await service.pinnedProviders(task)])].sort();
  const env = { ...service.env };
  const acquired: string[] = [];
  const environments: Record<string, NodeJS.ProcessEnv> = {};
  const keys: string[] = [];

  for (const adapter of adapters.values()) {
    for (const key of adapter.accessProfiles?.envKeys ?? []) {
      delete env[key];
    }
  }

  const rollback = async () => {
    for (const provider of acquired) {
      await service.discardPipelineLaunch(provider, task, launchId);
    }
  };

  try {
    for (const provider of providers) {
      if (!adapters.get(provider)?.accessProfiles) {
        continue;
      }

      const credentials = await service.pinPipeline(provider, task, attempt, attempt ? undefined : launchId);

      Object.assign(env, credentials);
      environments[provider] = { ...service.env, ...credentials };
      keys.push(...Object.keys(credentials));
      acquired.push(provider);
    }
  } catch (error) {
    await rollback();

    throw error;
  }

  return {
    env,
    environments,
    providers,
    keys,
    rollback,
  };
}
