import type {
  PluginNav, PluginPlacementDecl, PluginSetting, PluginSetup, PluginWebModule,
} from '../../../shared/plugins/pluginsContracts.ts';

// Вход автора содержит относительные пути, а не адреса ресурсов установленного модуля.
export interface PluginWebModuleManifest {
  dir: string;
  entry: string;
  css?: string[];
  locales?: { ru?: string; en?: string };
  startOnLogin?: boolean;
}

export interface PluginManifest {
  id: string;
  api?: 1 | 2;
  name?: string;
  version?: string;
  description?: string;
  category?: string;
  defaultEnabled?: boolean;
  nav?: (Pick<PluginNav, 'path'> & Partial<Pick<PluginNav, 'label' | 'icon' | 'order'>> & {
    group?: 'rail' | 'tools' | 'dock';
  }) | null;
  settings?: PluginSetting[];
  placements?: PluginPlacementDecl[];
  web?: string;
  webModule?: PluginWebModuleManifest;
  minGrigDeskVersion?: string;
  install?: { npm?: string[] };
}

export interface InstallablePluginManifest extends PluginManifest {
  version: string;
}

export interface PluginWebPage {
  dir: string;
  url: string;
}

// Нормализованный модуль options.plugin: адреса выдачи и абсолютный каталог сервера.
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
  serverEntry?: 'server.js' | 'server.ts' | null;
  serverError?: string | null;
  web?: PluginWebPage | null;
  webModule?: ResolvedPluginWebModule | null;
}
