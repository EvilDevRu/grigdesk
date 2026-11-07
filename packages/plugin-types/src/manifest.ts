import type {
  PluginNav, PluginPlacementDecl, PluginSetting, PluginSetup, PluginWebModule,
  PluginCompatibility, PluginContributions,
} from '../../../shared/plugins/pluginsContracts.ts';

// Автор объявляет собственные файлы; HTTP-адреса формирует только GrigDesk.
export interface PluginWebModuleManifest {
  dir: string;
  entry: string;
  background?: string;
  css?: string[];
  locales?: { ru?: string; en?: string };
}

export interface PluginManifest {
  id: string;
  api: 1;
  name?: string;
  version?: string;
  description: string;
  icon: string;
  category?: string;
  defaultEnabled?: boolean;
  engines?: { grigdesk: string };
  entrypoints: { server?: string; web?: PluginWebModuleManifest };
  contributes: PluginContributions;
  gallery?: { screenshots?: string[] };
  install?: { npm?: string[] };
}

export interface InstallablePluginManifest extends PluginManifest {
  version: string;
}

export interface ResolvedPluginWebModule extends PluginWebModule {
  dir: string;
}

export interface PluginMetadata {
  id: string;
  system?: boolean;
  defaultEnabled?: boolean;
  name: string;
  api?: number;
  version: string;
  description: string;
  category?: string;
  nav: PluginNav | null;
  settings: PluginSetting[];
  placements?: PluginPlacementDecl[];
  setup?: PluginSetup | null;
  dir?: string;
  hasServer?: boolean;
  serverEntry?: string | null;
  serverError?: string | null;
  icon?: string | null;
  iconPath?: string;
  compatibility?: PluginCompatibility;
  contributes?: PluginContributions;
  entrypoints?: { web?: ResolvedPluginWebModule | null };
}
