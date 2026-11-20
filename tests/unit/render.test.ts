import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { getTransitDataset } from '../../src/data/dataset';
import { CarInteriorLayer } from '../../src/render/CarInteriorLayer';
import { mergeBufferGeometries } from '../../src/render/geometryUtils';
import { LandmarkLayer } from '../../src/render/LandmarkLayer';
import { StructureLayer } from '../../src/render/StructureLayer';
import { TrackLayer } from '../../src/render/TrackLayer';
import { MAX_CARS, MAX_TRAINS, TrainLayer } from '../../src/render/TrainLayer';
import type { WorldStateSnapshot } from '../../src/types/state';

function collectRenderables(root: THREE.Object3D): Array<THREE.Mesh | THREE.LineSegments> {
  const list: Array<THREE.Mesh | THREE.LineSegments> = [];
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
      list.push(obj);
    }
  });
  return list;
}

function assertFiniteGeometry(geom: THREE.BufferGeometry): void {
  const pos = geom.getAttribute('position');
  expect(pos).toBeDefined();
  expect(pos.count).toBeGreaterThan(0);
  const arr = pos.array;
  let nonFiniteCount = 0;
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) nonFiniteCount++;
  }
  expect(nonFiniteCount).toBe(0);
}

function makeMockSnapshot(egoCarCount = 8, nearbyTrainCount = 3, carsPerNearby = 6): WorldStateSnapshot {
  const egoConsist = Array.from({ length: egoCarCount }, (_, i) => ({
    carIndex: i,
    enu: [100, 200 - i * 18.5, -14] as [number, number, number],
    headingRad: 0,
    pitchRad: 0,
    lengthM: 18,
    widthM: 3.0,
  }));

  const nearbyTrains = Array.from({ length: nearbyTrainCount }, (_, t) => ({
    id: `train-${t}`,
    system: (t % 2 === 0 ? 'MTA' : 'LIRR') as 'MTA' | 'LIRR',
    routeId: t % 2 === 0 ? 'A' : 'LIRR',
    color: t % 2 === 0 ? '#0039A6' : '#00985F',
    distanceM: 150 + t * 80,
    enu: [120 + t * 20, 250, -14] as [number, number, number],
    headingRad: 0,
    pitchRad: 0,
    carCount: carsPerNearby,
    carLengthM: 18,
    carWidthM: 3.0,
    cars: Array.from({ length: carsPerNearby }, (_, c) => ({
      enu: [120 + t * 20, 250 - c * 18.5, -14] as [number, number, number],
      headingRad: 0,
      pitchRad: 0,
    })),
  }));

  return {
    timestampMs: 1_700_000_000_000,
    mode: 'sim',
    ego: {
      routeId: 'A',
      serviceType: 'EXPRESS',
      direction: 'UPTOWN',
      displayLabel: 'A Express — Uptown',
      confidencePct: 92,
      candidates: [],
      currentStationId: 'mta-a-34',
      currentStationName: '34 St–Penn Station',
      nextStationId: 'mta-a-42',
      nextStationName: '42 St–Port Authority',
      etaSec: 45,
      // Positioned at carIndex 2
      positionEnu: [100, 200 - 2 * 18.5, -14],
      positionLatLng: { lat: 40.7549, lon: -73.984 },
      headingRad: 0,
      pitchRad: 0,
      speedMps: 15,
      speedMph: 33.5,
      elevationM: -14,
      elevationFt: -45.9,
      structure: 'UNDERGROUND_TUNNEL',
      outOfNyc: false,
      manualAnchorActive: false,
      sensorStatus: { gps: 'simulated', dr: 'simulated', timing: 'active' },
      system: 'MTA',
      routeColor: '#0039A6',
    },
    egoConsist,
    nearbyTrains,
    nearbyLandmarks: [],
  };
}

describe('geometryUtils', () => {
  it('merges indexed and non-indexed BufferGeometries and computes missing normals', () => {
    const box = new THREE.BoxGeometry(1, 2, 3);
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));

    const merged = mergeBufferGeometries([box, tri]);
    expect(merged.index).toBeNull();
    expect(merged.getAttribute('position').count).toBe(36 + 3);
    expect(merged.getAttribute('normal').count).toBe(36 + 3);

    box.dispose();
    tri.dispose();
    merged.dispose();
  });

  it('throws on empty geometry list', () => {
    expect(() => mergeBufferGeometries([])).toThrow();
  });
});

describe('3D Render Layers (full NYC dataset)', () => {
  const dataset = getTransitDataset();

  it('constructs all 5 layers with non-empty finite BufferGeometries and <= 50 total draw calls', () => {
    const carInterior = new CarInteriorLayer();
    const tracks = new TrackLayer(dataset.tracks);
    const trains = new TrainLayer();
    const structures = new StructureLayer(dataset);
    const landmarks = new LandmarkLayer(dataset.landmarks);

    const layers = [carInterior, tracks, trains, structures, landmarks];
    let totalDrawCalls = 0;

    for (const layer of layers) {
      const renderables = collectRenderables(layer.group);
      expect(renderables.length).toBeGreaterThan(0);
      totalDrawCalls += renderables.length;
      for (const obj of renderables) {
        assertFiniteGeometry(obj.geometry);
      }
    }

    expect(totalDrawCalls).toBeLessThanOrEqual(50);

    // Clean idempotent dispose on every layer
    for (const layer of layers) {
      layer.dispose();
      layer.dispose();
    }
  });

  it('renders all 4 named rivers at exact Y === 0 with DoubleSide and transparency', () => {
    const landmarks = new LandmarkLayer(dataset.landmarks);
    const waterMeshes = landmarks.getWaterMeshes();

    const expectedIds = ['east-river', 'hudson-river', 'harlem-river', 'upper-bay'];
    const foundIds = waterMeshes.map((m) => m.name).sort();
    expect(foundIds).toEqual([...expectedIds].sort());

    for (const mesh of waterMeshes) {
      const pos = mesh.geometry.getAttribute('position');
      expect(pos.count).toBeGreaterThan(0);
      for (let i = 0; i < pos.count; i++) {
        expect(pos.getY(i)).toBe(0);
      }

      const mat = mesh.material as THREE.MeshBasicMaterial;
      expect(mat.side).toBe(THREE.DoubleSide);
      expect(mat.transparent).toBe(true);
      expect(mat.depthWrite).toBe(false);
    }

    landmarks.dispose();
  });

  it('switches CarInteriorLayer cleanly across inside, ghost, and chase modes', () => {
    const car = new CarInteriorLayer();
    const egoPos = new THREE.Vector3(5, -10, -25);

    car.update(egoPos, 0.25, 0.02, 'inside');
    expect(car.group.visible).toBe(true);
    expect(car.group.position.x).toBeCloseTo(5, 5);

    car.update(egoPos, 0.25, 0.02, 'ghost');
    expect(car.group.visible).toBe(true);
    const shell = car.group.getObjectByName('car-interior-shell') as THREE.Mesh;
    const glass = car.group.getObjectByName('car-interior-glass') as THREE.Mesh;
    expect((shell.material as THREE.MeshBasicMaterial).wireframe).toBe(true);
    expect(glass.visible).toBe(false);

    car.update(egoPos, 0.25, 0.02, 'chase');
    expect(car.group.visible).toBe(false);

    car.dispose();
  });

  it('hides ego car in inside/ghost modes, includes it in chase mode, and clamps oversized train counts', () => {
    const trains = new TrainLayer();
    const snap = makeMockSnapshot(8, 3, 6); // 8 ego cars + 18 nearby = 26 total

    trains.update(snap, 'inside');
    expect(trains.getRenderedCarCount()).toBe(7 + 18);

    trains.update(snap, 'ghost');
    expect(trains.getRenderedCarCount()).toBe(7 + 18);

    trains.update(snap, 'chase', new THREE.Vector3(50, 0, -50));
    expect(trains.getRenderedCarCount()).toBe(8 + 18);
    expect(trains.getRenderedHeadlightCount()).toBe(4);
    expect(trains.getRenderedTaillightCount()).toBe(4);

    // Oversized snapshot clamps cleanly to MAX_CARS and MAX_TRAINS
    const hugeSnap = makeMockSnapshot(10, 80, 10);
    trains.update(hugeSnap, 'chase');
    expect(trains.getRenderedCarCount()).toBe(MAX_CARS);
    expect(trains.getRenderedHeadlightCount()).toBeLessThanOrEqual(MAX_TRAINS);
    expect(trains.getRenderedTaillightCount()).toBeLessThanOrEqual(MAX_TRAINS);

    trains.dispose();
  });

  it('supports StructureLayer ghost cutaway opacity and Node-safe procedural sign fallback', () => {
    const structures = new StructureLayer(dataset);
    const counts = structures.getCounts();

    expect(counts.tunnelRibs).toBeGreaterThan(0);
    expect(counts.viaductColumns).toBeGreaterThan(0);
    expect(counts.platforms).toBe(dataset.stations.length);

    expect(structures.getTunnelOpacity()).toBeCloseTo(0.72, 2);
    expect(structures.getTunnelDepthWrite()).toBe(true);

    structures.setViewMode('ghost');
    expect(structures.getTunnelOpacity()).toBeCloseTo(0.18, 2);
    expect(structures.getTunnelDepthWrite()).toBe(false);

    structures.setViewMode('inside');
    expect(structures.getTunnelOpacity()).toBeCloseTo(0.72, 2);
    expect(structures.getTunnelDepthWrite()).toBe(true);

    const signsMesh = structures.group.getObjectByName('structure-station-signs') as THREE.Mesh;
    expect(signsMesh).toBeDefined();
    const signsMat = signsMesh.material as THREE.MeshBasicMaterial;
    expect(signsMat.map).toBeInstanceOf(THREE.DataTexture);

    structures.dispose();
  });

  it('skips non-finite cars in TrainLayer and sanitizes non-finite inputs in CarInteriorLayer', () => {
    const trains = new TrainLayer();
    const snap = makeMockSnapshot(3, 1, 3);

    // Inject NaN/Infinity into egoConsist[0], nearbyTrains[0].cars[0], and dimensions
    snap.ego.positionEnu = [100, 181.5, -14];
    snap.egoConsist[0].enu = [NaN, 200, -14];
    snap.egoConsist[1].enu = [100, 181.5, -14]; // valid ego car (index 1)
    snap.egoConsist[2].enu = [100, 163.0, -14]; // valid sibling ego car
    snap.egoConsist[2].lengthM = NaN;
    snap.egoConsist[2].widthM = Infinity;

    snap.nearbyTrains[0].carLengthM = NaN;
    snap.nearbyTrains[0].carWidthM = -Infinity;
    snap.nearbyTrains[0].cars[0].enu = [NaN, Infinity, -10];
    snap.nearbyTrains[0].cars[1].enu = [140, 230, -12]; // valid sibling
    snap.nearbyTrains[0].cars[2].enu = [140, 211.5, -12]; // valid sibling

    // Non-finite originOffset falls back to 0 per component
    trains.update(snap, 'chase', new THREE.Vector3(NaN, Infinity, -Infinity));

    // 2 valid ego cars (index 1, 2) + 2 valid nearby cars (index 1, 2) = 4
    expect(trains.getRenderedCarCount()).toBe(4);
    expect(trains.getRenderedHeadlightCount()).toBe(0); // both lead cars (index 0) were non-finite and skipped
    expect(trains.getRenderedTaillightCount()).toBe(2); // both tail cars were finite

    const meshNames = ['train-bodies', 'train-stripes', 'train-headlights', 'train-taillights'];
    const mat = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    for (const name of meshNames) {
      const mesh = trains.group.getObjectByName(name) as THREE.InstancedMesh;
      expect(mesh).toBeDefined();
      const arr = mesh.instanceMatrix.array;
      for (let i = 0; i < mesh.count * 16; i++) {
        expect(Number.isFinite(arr[i])).toBe(true);
      }
    }

    // Verify valid sibling car transform and fallback dimensions (width=3.0, length=18.0)
    const bodyMesh = trains.group.getObjectByName('train-bodies') as THREE.InstancedMesh;
    bodyMesh.getMatrixAt(1, mat); // egoConsist[2]
    mat.decompose(pos, quat, scale);
    expect(pos.x).toBeCloseTo(100, 3);
    expect(pos.y).toBeCloseTo(-14 + 0.45, 3);
    expect(pos.z).toBeCloseTo(-163.0, 3);
    expect(scale.x).toBeCloseTo(3.0, 3);
    expect(scale.z).toBeCloseTo(18.0, 3);

    // Also verify non-finite ego.positionEnu in inside mode does not throw or write NaN
    snap.ego.positionEnu = [NaN, Infinity, -Infinity];
    trains.update(snap, 'inside', new THREE.Vector3(10, 0, -20));
    expect(trains.getRenderedCarCount()).toBe(4);
    for (const name of meshNames) {
      const mesh = trains.group.getObjectByName(name) as THREE.InstancedMesh;
      const arr = mesh.instanceMatrix.array;
      for (let i = 0; i < mesh.count * 16; i++) {
        expect(Number.isFinite(arr[i])).toBe(true);
      }
    }

    trains.dispose();

    // CarInteriorLayer NaN/Infinity sanitization
    const carInterior = new CarInteriorLayer();
    carInterior.update(new THREE.Vector3(NaN, 5, Infinity), NaN, -Infinity, 'inside');
    expect(carInterior.group.position.x).toBe(0);
    expect(carInterior.group.position.y).toBe(5);
    expect(carInterior.group.position.z).toBe(0);
    expect(Number.isFinite(carInterior.group.quaternion.x)).toBe(true);
    expect(Number.isFinite(carInterior.group.quaternion.y)).toBe(true);
    expect(Number.isFinite(carInterior.group.quaternion.z)).toBe(true);
    expect(Number.isFinite(carInterior.group.quaternion.w)).toBe(true);
    expect(carInterior.group.quaternion.length()).toBeCloseTo(1, 5);

    carInterior.dispose();
  });
});
