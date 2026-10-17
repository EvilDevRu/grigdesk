// Разбор форматов модели после проверки ресурсов, URI и пределов памяти.
// Результат содержит только сцену и её сводку; renderer здесь не создаётся.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import type { Studio3dStats } from '../../../../shared/studio3d/studio3dContracts.ts';
import { parseSplat } from './splat.ts';
import { modelResources, prepareResources } from './modelResources.ts';
import { createResourcePolicy, VIEWER_MEMORY } from './resourcePolicy.ts';
import type { ResourcePolicy } from './resourcePolicy.ts';
import { disposeModel, ownModelPolicy } from './modelDisposal.ts';

export interface ParsedModel {
  scene: THREE.Object3D;
  stats: Studio3dStats;
  clips: THREE.AnimationClip[];
  parts: string[];
  splat: boolean;
  memory: number;
  standalone: boolean;
}


/**
 * Сводка вычисляется по настоящим geometry/skins/clips, без renderer и предположения о взгляде.
 * Геометрия и изображения считаются вместе для общего бюджета двух панелей.
 */
function inspectScene(root: THREE.Object3D, clips: THREE.AnimationClip[], extensions: string[]): ParsedModel {
  const stats: Studio3dStats = {
    triangles: 0,
    vertices: 0,
    meshes: 0,
    materials: 0,
    bones: 0,
    animations: clips.map((clip) => ({ name: clip.name, duration: clip.duration })),
    textures: [],
    size: null,
    facing: null,
    parts: [],
    extensions
  };
  const materials = new Set<THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();
  const textures = new Set<THREE.Texture>();
  const parts: string[] = [];
  let memory = 0;
  
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    if ((object as THREE.Bone).isBone) {
      stats.bones += 1;
    }
    
    const mesh = object as THREE.Mesh;
    
    if (!(mesh.isMesh || (object as THREE.Points).isPoints)) {
      return;
    }
    
    stats.meshes += 1;
    
    const position = mesh.geometry.getAttribute('position');
    
    if (!position || position.count > 16_000_000) {
      throw new Error('Некорректная геометрия модели.');
    }
    
    for (let index = 0; index < position.count; index += 1) {
      if (![position.getX(index), position.getY(index), position.getZ(index)].every(Number.isFinite)) {
        throw new Error('Неконечная координата геометрии.');
      }
    }
    
    stats.vertices += position.count;
    
    if (mesh.isMesh) {
      stats.triangles += Math.floor((mesh.geometry.index?.count ?? position.count) / 3);
    }
    
    parts.push(mesh.name || `Часть ${parts.length + 1}`);
    
    if (!geometries.has(mesh.geometry)) {
      geometries.add(mesh.geometry);
      
      for (const attribute of Object.values(mesh.geometry.attributes)) {
        memory += attribute.array.byteLength * 2;
      }
      
      memory += (mesh.geometry.index?.array.byteLength || 0) * 2;
    }
    
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
      
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture && !textures.has(value)) {
          textures.add(value);
          
          const image = value.source?.data;
          const width = image?.width || 0;
          const height = image?.height || 0;
          
          if (width * height > 64_000_000) {
            throw new Error('Текстура превышает 64 Мп.');
          }
          
          memory += width * height * 8;
          stats.textures.push(width && height && value.userData.studioFormat ? {
            width,
            height,
            format: value.userData.studioFormat
          } : null);
        }
      }
    }
  });
  
  if (stats.triangles > 5_000_000 || memory > VIEWER_MEMORY) {
    throw new Error('Модель слишком тяжёлая для просмотра.');
  }
  
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  
  stats.size = [size.x, size.y, size.z];
  stats.materials = materials.size;
  stats.parts = parts;
  
  return {
    scene: root,
    stats,
    clips,
    parts,
    splat: false,
    memory,
    standalone: true,
  };
}

/**
 * Реальные addons разбирают формат после проверки source/URI/предела geometry.
 * Node может вызвать этот parser без WebGL; браузер передаёт свой policy и AbortSignal.
 */
export async function parseModel(input: Uint8Array | ArrayBuffer, extension: string,
  options: {
    policy?: ResourcePolicy;
    signal?: AbortSignal;
    reserve?: (memory: number) => void
  } = {})
  : Promise<ParsedModel> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const ext = extension.replace(/^\./, '').toLowerCase();
  
  if (!['glb', 'gltf', 'fbx', 'obj', 'stl', 'splat'].includes(ext)) {
    throw new Error('Этот формат или архив не поддержан. Сохраните самостоятельный GLB.');
  }
  
  const policy = options.policy || createResourcePolicy(`/api/studio3d/files/offline/fixture/model.${ext}`);
  const signal = options.signal || new AbortController().signal;
  let root: THREE.Object3D | null = null;
  
  try {
    options.reserve?.(bytes.byteLength * 2);

    const resources = modelResources(bytes, ext, policy);
    /**
     * Даже parser без renderer соблюдает предел входа и распакованных ресурсов.
     * Браузерный caller дополнительно проверяет общий бюджет сравнения.
     */
    const reserve = (memory: number) => {
      const amount = bytes.byteLength * 2 + memory;

      if (amount > VIEWER_MEMORY) {
        throw new Error('Модель и её ресурсы превышают бюджет 1024 МиБ.');
      }

      options.reserve?.(amount);
    };

    reserve(resources.decodedMemory);
    await prepareResources(resources, policy, signal, reserve);
    signal.throwIfAborted();
    
    const manager = new THREE.LoadingManager();
    let loading = false;
    let resourceError = false;
    let finishResources: () => void = () => {};
    const resourcesLoaded = new Promise<void>((resolve) => {
      finishResources = resolve;
    });

    manager.onStart = () => {
      loading = true;
    };
    manager.onLoad = () => finishResources();
    manager.onError = () => {
      resourceError = true;
    };
    
    manager.setURLModifier((url) => {
      // Preflight отвергает Blob URI входа. Остальные Blob создаёт сам addon для embedded media.
      // Они регистрируются в policy этого разбора и отзываются вместе с ним.
      if (url.startsWith('blob:')) {
        policy.registerBlob(url);
      }
      
      const resolved = policy.resolve(url);

      if (ext === 'fbx' && !resolved.startsWith('blob:') && !resolved.startsWith('data:')) {
        throw new Error('Необработанная внешняя текстура FBX. Сохраните самостоятельный GLB.');
      }

      return resolved;
    });
    
    let clips: THREE.AnimationClip[] = [];
    
    if (ext === 'glb' || ext === 'gltf') {
      const loader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
      const data = ext === 'gltf' ? new TextDecoder().decode(bytes) : new Uint8Array(bytes).buffer;
      const parsed = await loader.parseAsync(data, policy.directory);
      
      root = parsed.scene;
      clips = parsed.animations;

      root.traverse((object) => {
        const material = (object as THREE.Mesh).material;
        const entries = Array.isArray(material) ? material : material ? [material] : [];

        for (const entry of entries) {
          for (const texture of Object.values(entry)) {
            if (!(texture instanceof THREE.Texture)) {
              continue;
            }

            const id = parsed.parser.associations.get(texture)?.textures;
            const imageId = resources.json?.textures?.[id ?? -1]?.source;
            const image = resources.json?.images?.[imageId ?? -1];
            const mime = image?.mimeType || image?.uri || '';

            texture.userData.studioFormat = /jpeg|\.jpe?g(?:$|;)/i.test(mime) ? 'jpeg'
              : /webp/i.test(mime) ? 'webp' : /png/i.test(mime) ? 'png' : null;
          }
        }
      });
    } else if (ext === 'fbx') {
      root = new FBXLoader(manager).setResourcePath(policy.directory).parse(new Uint8Array(bytes).buffer,
        policy.directory);
      clips = root.animations || [];
    } else if (ext === 'obj') {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      
      if (/^\s*mtllib\s/m.test(text)) {
        throw new Error('OBJ с MTL не поддержан; сохраните самостоятельный GLB.');
      }
      
      root = new OBJLoader(manager).parse(text);
    } else if (ext === 'stl') {
      const geometry = new STLLoader(manager).parse(new Uint8Array(bytes).buffer);
      
      root = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color: 0xbec8d3,
        roughness: 0.75,
        side: THREE.DoubleSide
      }));
    } else {
      const splat = parseSplat(bytes);
      const geometry = new THREE.BufferGeometry();
      
      geometry.setAttribute('position', new THREE.BufferAttribute(splat.positions, 3));
      
      const colors = new Float32Array(splat.count * 3);
      
      for (let index = 0; index < splat.count; index += 1) {
        for (let channel = 0; channel < 3; channel += 1) {
          colors[index * 3 + channel] =
          splat.colors[index * 4 + channel]! / 255;
        }
      }
      
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      root = new THREE.Points(geometry, new THREE.PointsMaterial({
        size: 0.025,
        vertexColors: true,
        sizeAttenuation: true
      }));
    }
    
    if (loading) {
      await resourcesLoaded;
    }

    signal.throwIfAborted();

    if (resourceError) {
      throw new Error('Не удалось прочитать ресурс модели.');
    }
    
    const parsed = inspectScene(root, clips, resources.json?.extensionsUsed || []);
    
    parsed.splat = ext === 'splat';
    parsed.standalone = !resources.references.some((item) => !item.uri.startsWith('data:'));

    if (!options.policy) {
      ownModelPolicy(root, policy);
    }
    
    return parsed;
  } catch (cause) {
    if (root) {
      disposeModel(root);
    }
    
    policy.dispose();
    
    throw cause;
  }
}

