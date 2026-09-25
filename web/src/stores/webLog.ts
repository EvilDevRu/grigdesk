import { defineStore } from 'pinia';
import type { DiagnosticLevel } from '../../../shared/diagnosticLogging.ts';

export const useWebLogStore = defineStore('webLog', {
  state: () => ({
    ringCount: 0,
    ringFrom: null as string | null,
    ringTo: null as string | null,
    pendingCount: 0,
    storageAvailable: true,
    paused: false,
    lastError: null as string | null,
    lossCount: 0,
    level: null as DiagnosticLevel | null,
  }),
  actions: {
    setStatus(status: {
      ringCount: number;
      ringFrom: string | null;
      ringTo: string | null;
      pendingCount: number;
      storageAvailable: boolean;
      paused: boolean;
      lastError: string | null;
      lossCount: number;
      level: DiagnosticLevel | null;
    }) {
      Object.assign(this, status);
    },
  },
});
