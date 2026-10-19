export interface DeviceIdentity {
  key: string;
  cert: string;
}

export interface IdentityStore {
  load(directory: string): Promise<DeviceIdentity>;
  create(directory: string, name: string): Promise<DeviceIdentity>;
}
