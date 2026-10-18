import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'local.grigdesk.mobile',
  appName: 'GrigDesk',
  webDir: 'dist',
  server: { androidScheme: 'https' },
};

export default config;
