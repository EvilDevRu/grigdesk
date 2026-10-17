// Режимы материалов и раскраска частей принадлежат одному движку.
// Оригиналы возвращаются до освобождения модели вместе с её текстурами.
import * as THREE from 'three';

/**
 * Хранит оригиналы и заменители без renderer, RAF и состояния Vue.
 * Restore идемпотентен и освобождает только принадлежащие контроллеру заменители.
 */
export function createViewerMaterials() {
  let mode: 'texture' | 'clay' | 'wire' = 'texture';
  let partsOn = false;
  const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  const substitutes = new Map<THREE.Mesh, THREE.MeshStandardMaterial>();

  /**
   * Материалы сеток захватываются сразу после публикации сцены до смены режима.
   * Общие оригиналы сохраняются по ссылке, а не клонируются.
   */
  function capture(root: THREE.Object3D): void {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      
      if (mesh.isMesh) {
        originals.set(mesh, mesh.material);
      }
    });
  }

  /**
   * Clay/wire и раскраска частей используют принадлежащие движку материалы.
   * Оригиналы с texture не мутируются, поэтому возврат режима и dispose безопасны.
   */
  function apply(): void {
    let index = 0;
    
    for (const [mesh, original] of originals) {
      if (mode === 'texture' && !partsOn) {
        mesh.material = original;
        continue;
      }
      
      let replacement = substitutes.get(mesh);
      
      if (!replacement) {
        replacement = new THREE.MeshStandardMaterial({
          color: 0xbec8d3,
          roughness: 0.85,
          side: THREE.DoubleSide
        });
        substitutes.set(mesh, replacement);
      }
      if (partsOn) {
        replacement.color.setHSL((index++ * 0.618) % 1, 0.65, 0.58);
      }
      else {
        replacement.color.setHex(0xbec8d3);
      }
      
      replacement.wireframe = mode === 'wire';
      mesh.material = replacement;
    }
  }

  /**
   * Исходные материалы снова висят на сетках к моменту disposeModel.
   * Заменители освобождаются и карты очищаются ровно в прежнем порядке.
   */
  function restore(): void {
    for (const [mesh, material] of originals) {
      mesh.material = material;
    }
    for (const material of substitutes.values()) {
      material.dispose();
    }
    
    originals.clear();
    substitutes.clear();
  }

  return {
    capture,
    apply,
    restore,
    setMode(value: 'texture' | 'clay' | 'wire') {
      mode = value;
      apply();
    },
    showParts(value: boolean) {
      partsOn = value;
      apply();
    }
  };
}
