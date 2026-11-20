import * as THREE from 'three';

/**
 * Merge an array of BufferGeometries into a single non-indexed BufferGeometry.
 * Concatenates `position`, `normal` (computing vertex normals if missing),
 * and optional `color` (RGB) and `uv` (UV) attributes.
 */
export function mergeBufferGeometries(
  geometries: readonly THREE.BufferGeometry[],
): THREE.BufferGeometry {
  if (geometries.length === 0) {
    throw new Error('mergeBufferGeometries requires at least one BufferGeometry');
  }

  const normalized: THREE.BufferGeometry[] = [];
  const toDispose: THREE.BufferGeometry[] = [];

  let totalVertices = 0;
  let anyColor = false;
  let anyUv = false;

  try {
    for (const src of geometries) {
      const posAttr = src.getAttribute('position');
      if (!posAttr || posAttr.count === 0) {
        continue;
      }

      let geom: THREE.BufferGeometry;
      if (src.index !== null) {
        geom = src.toNonIndexed();
        toDispose.push(geom);
      } else if (!src.getAttribute('normal')) {
        geom = src.clone();
        toDispose.push(geom);
      } else {
        geom = src;
      }

      if (!geom.getAttribute('normal')) {
        geom.computeVertexNormals();
      }

      const count = geom.getAttribute('position').count;
      totalVertices += count;
      if (geom.getAttribute('color')) anyColor = true;
      if (geom.getAttribute('uv')) anyUv = true;
      normalized.push(geom);
    }

    if (totalVertices === 0) {
      throw new Error('mergeBufferGeometries received only empty geometries');
    }

    const positions = new Float32Array(totalVertices * 3);
    const normals = new Float32Array(totalVertices * 3);
    const colors = anyColor ? new Float32Array(totalVertices * 3) : null;
    const uvs = anyUv ? new Float32Array(totalVertices * 2) : null;

    let vertexOffset = 0;

    for (const geom of normalized) {
      const pos = geom.getAttribute('position');
      const norm = geom.getAttribute('normal');
      const col = geom.getAttribute('color');
      const uv = geom.getAttribute('uv');
      const count = pos.count;

      for (let i = 0; i < count; i++) {
        const idx3 = (vertexOffset + i) * 3;
        positions[idx3] = pos.getX(i);
        positions[idx3 + 1] = pos.getY(i);
        positions[idx3 + 2] = pos.getZ(i);

        normals[idx3] = norm.getX(i);
        normals[idx3 + 1] = norm.getY(i);
        normals[idx3 + 2] = norm.getZ(i);

        if (colors) {
          if (col) {
            colors[idx3] = col.getX(i);
            colors[idx3 + 1] = col.getY(i);
            colors[idx3 + 2] = col.getZ(i);
          } else {
            colors[idx3] = 1;
            colors[idx3 + 1] = 1;
            colors[idx3 + 2] = 1;
          }
        }

        if (uvs) {
          const idx2 = (vertexOffset + i) * 2;
          if (uv) {
            uvs[idx2] = uv.getX(i);
            uvs[idx2 + 1] = uv.getY(i);
          } else {
            uvs[idx2] = 0;
            uvs[idx2 + 1] = 0;
          }
        }
      }

      vertexOffset += count;
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    if (colors) {
      merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    if (uvs) {
      merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    }
    merged.computeBoundingSphere();
    return merged;
  } finally {
    for (const g of toDispose) {
      g.dispose();
    }
  }
}

/**
 * Fill a uniform RGB vertex color attribute on a BufferGeometry in place.
 */
export function setUniformVertexColor(
  geom: THREE.BufferGeometry,
  color: THREE.Color,
): THREE.BufferGeometry {
  const pos = geom.getAttribute('position');
  const count = pos ? pos.count : 0;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const idx = i * 3;
    arr[idx] = color.r;
    arr[idx + 1] = color.g;
    arr[idx + 2] = color.b;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geom;
}
