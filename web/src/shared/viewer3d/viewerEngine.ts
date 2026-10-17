import type { Studio3dStats } from '../../../../shared/studio3d/studio3dContracts.ts';

export interface ViewerInfo {
  stats: Studio3dStats;
  clips: { name: string; duration: number }[];
  parts: string[];
  splat?: boolean;
  standalone?: boolean;
}

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  zoom: number;
}

export interface ViewerOptions {
  onError?: (message: string) => void;
  onProgress?: (loaded: number, total: number | null) => void;
}

export interface ViewerEngine {
  load(url: string, ext: string): Promise<ViewerInfo>;
  setMode(mode: 'texture' | 'clay' | 'wire'): void;
  showBones(on: boolean): void;
  showParts(on: boolean): void;
  setBackground(mode: 'dark' | 'light' | 'checker'): void;
  setLight(mode: 'studio' | 'flat'): void;
  playClip(name: string | null): void;
  setTime(seconds: number): void;
  setSpeed(speed: number): void;
  fitView(): void;
  snapshot(): Promise<Blob>;
  onCameraChange(callback: (state: CameraState) => void): () => void;
  syncCamera(state: CameraState): void;
  onTimeChange(callback: (seconds: number) => void): () => void;
  setVisible(on: boolean): void;
  resize(): void;
  dispose(): void;
}

export type ViewerFactory = (canvas: HTMLCanvasElement, options?: ViewerOptions) => ViewerEngine;

/**
 * Three загружается только после открытия модели, отдельным динамическим чанком.
 * Порт остаётся небольшим и позволяет тестировать controls без WebGL заглушек в продукте.
 */
export async function loadEngine(): Promise<ViewerFactory> {
  return (await import('./engine.ts')).createEngine;
}
