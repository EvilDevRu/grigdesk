export interface ExternalCliDefinition {
  packageId: string;
  binName: string;
  configKey: string;
  envKey: string;
  native?: { entry: string; root: string }[];
}

export type { ExternalCliInstallation, ExternalCliInventory }
  from '../../../../shared/chat/providerInstallationInventory.ts';

export interface ExternalCliInventoryInput {
  providerId: string;
  definition: ExternalCliDefinition;
  configuredBin: string;
  env: NodeJS.ProcessEnv;
  home: string;
  legacyRoots?: string[];
}
