// Поля Docker Engine, которые использует нормализация панели. Необязательные поля
// сохраняют совместимость с версиями демона, где часть метаданных отсутствует.

export interface EnginePort {
  PrivatePort: number;
  PublicPort?: number;
  Type?: string;
  IP?: string;
}

export interface EngineMount {
  Type?: string;
  Name?: string;
  Source?: string;
  Destination?: string;
  RW?: boolean;
}

export interface EngineContainer {
  Id: string;
  Names?: string[];
  Image?: string;
  ImageID?: string;
  Command?: string;
  Created?: number;
  State?: string;
  Status?: string;
  Health?: { Status?: string };
  Ports?: EnginePort[];
  Labels?: Record<string, string> | null;
  NetworkSettings?: { Networks?: Record<string, unknown> };
  Mounts?: EngineMount[];
  SizeRw?: number;
}

export interface EngineImage {
  Id: string;
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
  Size?: number;
  Created?: number;
}

export interface EngineVolume {
  Name: string;
  Driver?: string;
  CreatedAt?: string;
  Mountpoint?: string;
  Labels?: Record<string, string> | null;
  UsageData?: { Size?: number };
}

export interface EngineNetwork {
  Id: string;
  Name: string;
  Driver?: string;
  Scope?: string;
  Internal?: boolean;
  Created?: string;
  IPAM?: { Config?: Array<{ Subnet?: string }> };
}

export interface EngineBuildCache {
  ID: string;
  Type?: string;
  InUse?: boolean;
  Shared?: boolean;
  Size?: number;
  CreatedAt?: string;
  LastUsedAt?: string;
}

export interface EngineResourceUsage {
  TotalCount?: number;
  ActiveCount?: number;
  TotalSize?: number;
  Reclaimable?: number;
}

export interface EngineDiskUsage {
  ImageUsage?: EngineResourceUsage;
  ContainerUsage?: EngineResourceUsage;
  VolumeUsage?: EngineResourceUsage;
  BuildCacheUsage?: EngineResourceUsage;
  BuildCache?: EngineBuildCache[];
  Volumes?: EngineVolume[];
}

interface EngineCpuStats {
  cpu_usage?: {
    total_usage?: number;
    percpu_usage?: number[];
  };
  system_cpu_usage?: number;
  online_cpus?: number;
}

export interface EngineStats {
  read?: string;
  cpu_stats?: EngineCpuStats;
  precpu_stats?: EngineCpuStats;
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: {
      inactive_file?: number;
      total_inactive_file?: number;
    };
  };
  networks?: Record<string, {
    rx_bytes?: number;
    tx_bytes?: number;
  }>;
  blkio_stats?: {
    io_service_bytes_recursive?: Array<{
      op?: string;
      value?: number;
    }>;
  };
  pids_stats?: { current?: number };
}
