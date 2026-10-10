import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'local.cockpit.mobile',
  appName: 'Кокпит',
  webDir: 'dist',
  server: { androidScheme: 'https' },
};

export default config;
