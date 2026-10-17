// Освобождение сцены модели и policy, принадлежащей отдельному разбору.
// Shared GPU-ресурсы и ImageBitmap освобождаются по одному разу.
import * as THREE from 'three';
import type { ResourcePolicy } from './resourcePolicy.ts';

const ownedPolicies = new WeakMap<THREE.Object3D, ResourcePolicy>();

/**
 * Parser без внешней policy передаёт её вместе со сценой одному владельцу disposal.
 * Внешняя policy остаётся у загрузки и не регистрируется второй раз.
 */
export function ownModelPolicy(root: THREE.Object3D, policy: ResourcePolicy): void {
  ownedPolicies.set(root, policy);
}

/**
 * Geometry/material/texture освобождаются ровно один раз, включая shared ресурсы сеток.
 * ImageBitmap закрывается отдельно: renderer.dispose сам не освобождает его RAM.
 */
export function disposeModel(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    
    if (mesh.geometry) {
      geometries.add(mesh.geometry);
    }
    
    const entries = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];

    for (const material of entries) {
      materials.add(material);
      
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) {
        textures.add(value);
      }
    }
  });
  
  for (const geometry of geometries) {
    geometry.dispose();
  }
  for (const material of materials) {
    material.dispose();
  }
  for (const texture of textures) {
    const image = texture.source?.data;
    
    if (image && typeof image === 'object' && 'close' in image && typeof image.close === 'function') {
      image.close();
    }
    
    texture.dispose();
  }

  ownedPolicies.get(root)?.dispose();
  ownedPolicies.delete(root);
}

