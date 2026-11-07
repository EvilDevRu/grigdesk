export type RelayInfo = {
  id: string;
  name: string;
  host: string;
  port: number;
  state?: 'online' | 'offline' | 'connecting' | 'waiting_vpn';
};
export type LinkState = {
  paired: boolean;
  brainName: string;
  deviceName: string;
  deviceId?: string;
  relays: RelayInfo[];
  activeRelayId: string | null;
  unlocked: boolean;
  fontScale: number;
  generation: number;
  revoked?: boolean;
  error?: string;
};
export type OperationIntent = {
  method: 'POST';
  path: string;
  body: string;
  idempotencyKey: string;
  createdAt: number;
  clientId?: string;
  chatId?: string;
  order?: number;
};
export type RequestInput = {
  method: 'GET' | 'POST';
  path: string;
  body?: string;
  idempotencyKey?: string;
  createdAt?: number;
};
export type LinkEvent = {
  name: string;
  data: string;
  generation: number;
};
export type Listener = { remove: () => Promise<void> };
export interface GrigDeskLink {
  getState(): Promise<LinkState>;
  addFromText(input: { text: string }): Promise<void>;
  scanQr(): Promise<{ text: string }>;
  selectRelay(input: { id: string }): Promise<void>;
  removeRelay(input: { id: string }): Promise<void>;
  unlock(): Promise<void>;
  request(input: RequestInput): Promise<{
    status: number;
    body: string;
    generation: number;
  }>;
  getOutbox(): Promise<{ items: OperationIntent[] }>;
  putOutbox(input: { item: OperationIntent }): Promise<void>;
  removeOutbox(input: { idempotencyKey: string }): Promise<void>;
  startEvents(): Promise<void>;
  stopEvents(): Promise<void>;
  fetchMedia(input: { chatId: string; ref: string }): Promise<{
    path?: string;
    error?: string;
  }>;
  downloadUpdate(): Promise<void>;
  resetDevice(): Promise<void>;
  addListener(name: 'linkEvent', callback: (event: LinkEvent) => void): Promise<Listener>;
  addListener(
    name: 'linkState',
    callback: (state: Partial<LinkState> & { state?: string }) => void,
  ): Promise<Listener>;
}
