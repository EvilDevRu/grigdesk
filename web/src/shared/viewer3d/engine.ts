import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ViewerEngine, ViewerOptions, ViewerInfo, CameraState } from './viewerEngine.ts';
import type { ParsedModel } from './modelParser.ts';
import { createViewerAnimation } from './viewerAnimation.ts';
import { createViewerMaterials } from './viewerMaterials.ts';
import { disposeModel } from './modelDisposal.ts';
import { createViewerLoading } from './viewerLoading.ts';
import { checkViewerContext, claimViewerContext, createViewerLease } from './viewerBudget.ts';
import type { ViewerModelLease } from './viewerBudget.ts';
import type { ResourcePolicy } from './resourcePolicy.ts';

export { parseModel } from './modelParser.ts';
export { disposeModel } from './modelDisposal.ts';
export { viewerDiagnostics } from './viewerBudget.ts';

/**
 * Renderer создаётся только для видимого viewer, максимум два контекста и 1024 МиБ вместе.
 * Dispose симметричен RAF, controls, mixer, listeners, Blob и ресурсам GPU.
 */
export function createEngine(canvas: HTMLCanvasElement, options: ViewerOptions = {}): ViewerEngine {
  checkViewerContext();

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true
  });
  
  const releaseContext = claimViewerContext();

  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x101722);
  
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, canvas);
  
  controls.enableDamping = false;
  
  const ambient = new THREE.HemisphereLight(0xe8f1ff, 0x48536b, 1.8);
  const key = new THREE.DirectionalLight(0xffffff, 3);
  const fill = new THREE.DirectionalLight(0x8cafff, 1.6);
  
  key.position.set(4, 6, 5);
  fill.position.set(-4, 2, -3);
  scene.add(ambient, key, fill);
  
  const materials = createViewerMaterials();
  const animation = createViewerAnimation(() => renderer.render(scene, camera));
  let model: ParsedModel | null = null;
  let skeleton: THREE.SkeletonHelper | null = null;
  let policy: ResourcePolicy | null = null;
  let disposed = false;
  let visible = true;
  let lost = false;
  let raf = 0;
  let previous = 0;
  let lastTimeEvent = 0;
  let modelLease: ViewerModelLease | null = null;
  let bonesOn = false;
  let syncing = false;
  const cameraCallbacks = new Set<(state: CameraState) => void>();
  const timeCallbacks = new Set<(seconds: number) => void>();
  const checker = new THREE.DataTexture(new Uint8Array([
    45, 51, 63, 255, 64, 71, 85, 255, 64, 71, 85, 255, 45, 51, 63, 255,
  ]), 2, 2);
  
  checker.wrapS = checker.wrapT = THREE.RepeatWrapping;
  checker.repeat.set(20, 20);
  checker.magFilter = THREE.NearestFilter;
  checker.needsUpdate = true;

  /**
   * Публикация камеры не отзеркаливается обратно при sync, иначе compare зацикливается.
   * Числа принадлежат публичному порту, Three objects в Vue не попадают.
   */
  const cameraChanged = () => {
    if (syncing || disposed) {
      return;
    }
    
    const state: CameraState = {
      position: camera.position.toArray() as [number, number, number],
      target: controls.target.toArray() as [number, number, number],
      up: camera.up.toArray() as [number, number, number],
      zoom: camera.zoom
    };
    
    for (const callback of cameraCallbacks) {
      callback(state);
    }
  };
  
  controls.addEventListener('change', cameraChanged);

  /**
   * Один RAF на движок работает только пока холст видим и контекст доступен.
   * AnimationMixer меняет настоящую позу; UI время публикуется не чаще десяти раз в секунду.
   */
  const frame = (now: number) => {
    raf = 0;
    
    if (disposed || !visible || lost) {
      return;
    }
    
    const delta = previous ? Math.min(0.1, (now - previous) / 1000) : 0;
    
    previous = now;
    
    animation.advance(delta);
    
    controls.update();
    renderer.render(scene, camera);
    
    if (now - lastTimeEvent > 100) {
      lastTimeEvent = now;
      
      for (const callback of timeCallbacks) {
        callback(animation.currentTime());
      }
    }
    
    raf = requestAnimationFrame(frame);
  };

  /**
   * Перезапуск RAF не оставляет большое delta после скрытой вкладки или потери контекста.
   * Старый callback отменяется до постановки следующего.
   */
  const schedule = () => {
    if (raf) {
      cancelAnimationFrame(raf);
    }
    
    raf = 0;
    previous = 0;
    
    if (!disposed && visible && !lost) {
      raf = requestAnimationFrame(frame);
    }
  };

  /**
   * Очистка restores исходные materials, чтобы shared textures были освобождены один раз.
   * Memory lease снимается до следующего load, включая ошибку или устаревший результат.
   */
  const clear = () => {
    animation.dispose();

    if (skeleton) {
      scene.remove(skeleton);
      skeleton.geometry.dispose();
      (skeleton.material as THREE.Material).dispose();
    }
    
    skeleton = null;
    
    materials.restore();

    if (model) {
      scene.remove(model.scene);
      disposeModel(model.scene);
    }
    
    model = null;
    modelLease?.release();
    modelLease = null;
    policy?.dispose();
    policy = null;
  };

  /**
   * Bounding box определяет дистанцию и target без автоматического разворота модели.
   * Нулевая или плоская геометрия всё равно получает положительные near/far и canvas.
   */
  const fitView = () => {
    if (!model) {
      return;
    }
    
    const box = new THREE.Box3().setFromObject(model.scene);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 0.1);
    
    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(radius * 1.8, radius * 1.1, radius * 2.2));
    camera.near = Math.max(0.0001, radius / 1000);
    camera.far = Math.max(100, radius * 100);
    camera.updateProjectionMatrix();
    controls.update();
    renderer.render(scene, camera);
  };

  const loading = createViewerLoading({
    isClosed: () => disposed || lost,
    isDisposed: () => disposed,
    clearCurrent: clear,
    onProgress: options.onProgress,
    budget: { createLease: createViewerLease },
    /**
     * Публикация передаёт сцену, policy и model lease до настройки controls и кадра.
     * Порядок прежнего блока сохранён для симметричного clear при любом отказе.
     */
    publish(parsed, resources, lease): ViewerInfo {
      modelLease = lease;
      policy = resources;
      model = parsed;
      scene.add(parsed.scene);
      materials.capture(model.scene);

      if (model.stats.bones) {
        skeleton = new THREE.SkeletonHelper(model.scene);
        skeleton.visible = bonesOn;
        scene.add(skeleton);
      }
      
      animation.setModel(model);
      materials.apply();
      fitView();
      
      return {
        stats: parsed.stats,
        clips: parsed.clips.map((clip) => ({ name: clip.name, duration: clip.duration })),
        parts: parsed.parts,
        splat: parsed.splat,
        standalone: parsed.standalone,
      };
    }
  });

  /**
   * Потеря контекста даёт управляемый отказ и останавливает рендер до закрытия/повторного открытия.
   * Callback не остаётся на чужом canvas после dispose.
   */
  const contextLost = (event: Event) => {
    event.preventDefault();
    lost = true;
    loading.abort();
    schedule();
    options.onError?.('Контекст WebGL потерян. Закройте и откройте просмотр снова.');
  };
  
  canvas.addEventListener('webglcontextlost', contextLost);
  schedule();

  return {
    load: loading.load,
    setMode(value) {
      materials.setMode(value);
    },
    showParts(value) {
      materials.showParts(value);
    },
    showBones(value) { bonesOn = value; 
    
    if (skeleton) {
      skeleton.visible = value;
    } },
    /**
     * Фон меняется без пересоздания renderer и потери камеры.
     * Checker texture принадлежит движку и освобождается при close.
     */
    setBackground(value) {
      const color = value === 'light' ? 0xe7edf6 : 0x101722;

      scene.background = value === 'checker' ? checker : new THREE.Color(color);
    },
    setLight(value) {
      key.visible = fill.visible = value === 'studio';
      ambient.intensity = value === 'flat' ? 3 : 1.8;
    },
    playClip(name) {
      animation.playClip(name);
    },
    setTime(seconds) {
      animation.setTime(seconds);
    },
    setSpeed(value) {
      animation.setSpeed(value);
    },
    fitView,
    async snapshot() {
      if (disposed || lost || !model) {
        throw new Error('Для снимка нужна загруженная модель.');
      }
      
      renderer.render(scene, camera);
      
      return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Не удалось создать WebP снимок.'));
        }
      }, 'image/webp', 0.88));
    },
    onCameraChange(callback) {
      cameraCallbacks.add(callback);
      
      return () => cameraCallbacks.delete(callback);
    },
    /**
     * Камера принимает только конечные числа публичного порта.
     * Sync подавляет обратное событие и не запускает цикл compare.
     */
    syncCamera(state) {
      if (disposed || [...state.position, ...state.target, ...state.up,
        state.zoom].some((value) => !Number.isFinite(value))) {
        return;
      }
      
      syncing = true;
      camera.position.fromArray(state.position);
      camera.up.fromArray(state.up);
      controls.target.fromArray(state.target);
      camera.zoom = state.zoom;
      camera.updateProjectionMatrix();
      controls.update();
      syncing = false;
    },
    onTimeChange(callback) {
      timeCallbacks.add(callback);
      
      return () => timeCallbacks.delete(callback);
    },
    setVisible(value) {
      visible = value;
      schedule();
    },
    /**
     * Размер framebuffer следует за видимой областью canvas.
     * Обновление aspect не меняет target и положение камеры.
     */
    resize() {
      if (disposed) {
        return;
      }
      
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    },
    /**
     * Закрытие идемпотентно и симметрично созданным ресурсам.
     * RAF, callbacks, сцена, controls и WebGL контекст освобождаются вместе.
     */
    dispose() {
      if (disposed) {
        return;
      }
      
      disposed = true;
      loading.invalidate();
      
      if (raf) {
        cancelAnimationFrame(raf);
      }
      
      raf = 0;
      canvas.removeEventListener('webglcontextlost', contextLost);
      controls.removeEventListener('change', cameraChanged);
      controls.dispose();
      cameraCallbacks.clear();
      timeCallbacks.clear();
      clear();
      checker.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      releaseContext();
    },
  };
}

