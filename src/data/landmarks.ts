import { wgs84ToEnu } from '../geo/projection';
import type {
  BoroughOutline,
  BridgeLandmark,
  LandmarkDataset,
  Vec2,
  Vec3,
  WaterBodyLandmark,
  WaterLandmarkId,
} from '../types/transit';

function projectRing(coords: ReadonlyArray<readonly [number, number]>): Vec2[] {
  return coords.map(([lat, lon]) => {
    const [e, n] = wgs84ToEnu(lat, lon, 0);
    return [e, n];
  });
}

function computeCentroid2D(pts: readonly Vec2[]): Vec2 {
  if (pts.length === 0) return [0, 0];
  let sx = 0;
  let sy = 0;
  for (const [x, y] of pts) {
    sx += x;
    sy += y;
  }
  return [sx / pts.length, sy / pts.length];
}

interface RawWaterBody {
  id: WaterLandmarkId;
  name: string;
  color: string;
  polygonLatLon: ReadonlyArray<readonly [number, number]>;
  centerlineLatLon: ReadonlyArray<readonly [number, number]>;
}

const RAW_WATER_BODIES: readonly RawWaterBody[] = [
  {
    id: 'hudson-river',
    name: 'Hudson River',
    color: '#0e4f78',
    polygonLatLon: [
      [40.701, -74.018],
      [40.718, -74.015],
      [40.742, -74.010],
      [40.764, -74.000],
      [40.785, -73.987],
      [40.812, -73.968],
      [40.840, -73.950],
      [40.858, -73.943],
      [40.858, -73.960],
      [40.838, -73.968],
      [40.808, -73.987],
      [40.782, -74.005],
      [40.758, -74.018],
      [40.735, -74.027],
      [40.715, -74.032],
      [40.701, -74.035],
    ],
    centerlineLatLon: [
      [40.701, -74.026],
      [40.722, -74.022],
      [40.748, -74.014],
      [40.774, -74.001],
      [40.805, -73.982],
      [40.835, -73.962],
      [40.858, -73.951],
    ],
  },
  {
    id: 'east-river',
    name: 'East River',
    color: '#0d5b86',
    polygonLatLon: [
      [40.700, -74.012],
      [40.707, -74.001],
      [40.711, -73.985],
      [40.714, -73.975],
      [40.728, -73.971],
      [40.744, -73.969],
      [40.759, -73.958],
      [40.775, -73.943],
      [40.793, -73.930],
      [40.797, -73.918],
      [40.785, -73.918],
      [40.770, -73.934],
      [40.754, -73.949],
      [40.739, -73.959],
      [40.722, -73.962],
      [40.707, -73.968],
      [40.702, -73.983],
      [40.699, -73.997],
      [40.694, -74.006],
    ],
    centerlineLatLon: [
      [40.698, -74.007],
      [40.704, -73.994],
      [40.707, -73.981],
      [40.713, -73.970],
      [40.732, -73.966],
      [40.750, -73.958],
      [40.767, -73.944],
      [40.785, -73.930],
      [40.795, -73.922],
    ],
  },
  {
    id: 'harlem-river',
    name: 'Harlem River',
    color: '#11638f',
    polygonLatLon: [
      [40.795, -73.930],
      [40.808, -73.933],
      [40.822, -73.933],
      [40.840, -73.930],
      [40.860, -73.919],
      [40.875, -73.913],
      [40.878, -73.926],
      [40.873, -73.928],
      [40.869, -73.917],
      [40.856, -73.924],
      [40.838, -73.935],
      [40.820, -73.938],
      [40.806, -73.937],
      [40.794, -73.934],
    ],
    centerlineLatLon: [
      [40.795, -73.932],
      [40.807, -73.935],
      [40.821, -73.936],
      [40.839, -73.932],
      [40.858, -73.921],
      [40.874, -73.918],
    ],
  },
  {
    id: 'upper-bay',
    name: 'Upper New York Bay',
    color: '#0a4369',
    polygonLatLon: [
      [40.701, -74.035],
      [40.700, -74.012],
      [40.688, -74.006],
      [40.672, -74.015],
      [40.652, -74.028],
      [40.635, -74.042],
      [40.640, -74.072],
      [40.665, -74.065],
      [40.686, -74.050],
    ],
    centerlineLatLon: [
      [40.698, -74.024],
      [40.680, -74.028],
      [40.660, -74.040],
      [40.642, -74.055],
    ],
  },
];

interface RawBorough {
  id: string;
  name: string;
  color: string;
  outlineLatLon: ReadonlyArray<readonly [number, number]>;
}

const RAW_BOROUGHS: readonly RawBorough[] = [
  {
    id: 'manhattan',
    name: 'Manhattan',
    color: '#1e293b',
    outlineLatLon: [
      [40.701, -74.017],
      [40.706, -74.002],
      [40.713, -73.977],
      [40.735, -73.972],
      [40.758, -73.960],
      [40.782, -73.943],
      [40.805, -73.934],
      [40.835, -73.934],
      [40.873, -73.914],
      [40.877, -73.927],
      [40.850, -73.946],
      [40.815, -73.964],
      [40.778, -73.991],
      [40.745, -74.009],
      [40.718, -74.015],
    ],
  },
  {
    id: 'brooklyn',
    name: 'Brooklyn',
    color: '#172033',
    outlineLatLon: [
      [40.735, -73.960],
      [40.715, -73.965],
      [40.702, -73.995],
      [40.685, -74.008],
      [40.655, -74.025],
      [40.618, -74.035],
      [40.585, -73.975],
      [40.625, -73.900],
      [40.680, -73.890],
      [40.715, -73.915],
    ],
  },
  {
    id: 'queens',
    name: 'Queens',
    color: '#172033',
    outlineLatLon: [
      [40.736, -73.960],
      [40.758, -73.948],
      [40.782, -73.922],
      [40.785, -73.840],
      [40.755, -73.760],
      [40.680, -73.760],
      [40.640, -73.780],
      [40.665, -73.860],
      [40.705, -73.910],
    ],
  },
  {
    id: 'bronx',
    name: 'The Bronx',
    color: '#172033',
    outlineLatLon: [
      [40.802, -73.930],
      [40.830, -73.931],
      [40.875, -73.912],
      [40.910, -73.905],
      [40.900, -73.820],
      [40.840, -73.810],
      [40.805, -73.880],
    ],
  },
  {
    id: 'new-jersey',
    name: 'New Jersey',
    color: '#151c2c',
    outlineLatLon: [
      [40.660, -74.065],
      [40.705, -74.035],
      [40.738, -74.027],
      [40.775, -74.010],
      [40.820, -73.980],
      [40.865, -73.958],
      [40.865, -74.120],
      [40.730, -74.200],
      [40.660, -74.180],
    ],
  },
];

interface RawBridge {
  id: string;
  name: string;
  riverId: WaterLandmarkId;
  deckElevationM: number;
  towerHeightM: number;
  widthM: number;
  color: string;
  startLatLon: readonly [number, number];
  endLatLon: readonly [number, number];
}

const RAW_BRIDGES: readonly RawBridge[] = [
  {
    id: 'manhattan-bridge',
    name: 'Manhattan Bridge',
    riverId: 'east-river',
    deckElevationM: 40,
    towerHeightM: 102,
    widthM: 49,
    color: '#60a5fa',
    startLatLon: [40.7138, -73.9935],
    endLatLon: [40.7008, -73.9879],
  },
  {
    id: 'williamsburg-bridge',
    name: 'Williamsburg Bridge',
    riverId: 'east-river',
    deckElevationM: 41,
    towerHeightM: 95,
    widthM: 36,
    color: '#94a3b8',
    startLatLon: [40.7170, -73.9845],
    endLatLon: [40.7104, -73.9625],
  },
  {
    id: 'brooklyn-bridge',
    name: 'Brooklyn Bridge',
    riverId: 'east-river',
    deckElevationM: 39,
    towerHeightM: 84,
    widthM: 26,
    color: '#d6b88e',
    startLatLon: [40.7115, -74.0030],
    endLatLon: [40.7010, -73.9905],
  },
  {
    id: 'queensboro-bridge',
    name: 'Queensboro Bridge',
    riverId: 'east-river',
    deckElevationM: 40,
    towerHeightM: 107,
    widthM: 30,
    color: '#cbd5e1',
    startLatLon: [40.7600, -73.9618],
    endLatLon: [40.7525, -73.9445],
  },
  {
    id: 'george-washington-bridge',
    name: 'George Washington Bridge',
    riverId: 'hudson-river',
    deckElevationM: 65,
    towerHeightM: 184,
    widthM: 36,
    color: '#e2e8f0',
    startLatLon: [40.8505, -73.9455],
    endLatLon: [40.8528, -73.9615],
  },
];

export function createLandmarks(): LandmarkDataset {
  const waterBodies: WaterBodyLandmark[] = RAW_WATER_BODIES.map((raw) => {
    const polygonEnu = projectRing(raw.polygonLatLon);
    const centerlineEnu = projectRing(raw.centerlineLatLon);
    return {
      id: raw.id,
      name: raw.name,
      elevationM: 0,
      color: raw.color,
      polygonEnu,
      centerlineEnu,
      centroidEnu: computeCentroid2D(polygonEnu),
    };
  });

  const boroughs: BoroughOutline[] = RAW_BOROUGHS.map((raw) => {
    const outlineEnu = projectRing(raw.outlineLatLon);
    return {
      id: raw.id,
      name: raw.name,
      elevationM: 2,
      color: raw.color,
      outlineEnu,
      centroidEnu: computeCentroid2D(outlineEnu),
    };
  });

  const bridges: BridgeLandmark[] = RAW_BRIDGES.map((raw) => {
    const start3 = wgs84ToEnu(raw.startLatLon[0], raw.startLatLon[1], raw.deckElevationM);
    const end3 = wgs84ToEnu(raw.endLatLon[0], raw.endLatLon[1], raw.deckElevationM);
    const p0: Vec2 = [start3[0], start3[1]];
    const p1: Vec2 = [end3[0], end3[1]];

    const lerp2 = (t: number): Vec2 => [
      p0[0] + t * (p1[0] - p0[0]),
      p0[1] + t * (p1[1] - p0[1]),
    ];

    const deckPointsEnu: Vec3[] = [0, 0.25, 0.5, 0.75, 1].map((t) => {
      const [e, n] = lerp2(t);
      // Slight gentle arch peaking at midpoint (+2m)
      const arch = Math.sin(t * Math.PI) * 2.0;
      return [e, n, raw.deckElevationM + arch];
    });

    const towersEnu: Vec2[] = [lerp2(0.28), lerp2(0.72)];
    const centroidEnu: Vec2 = lerp2(0.5);

    return {
      id: raw.id,
      name: raw.name,
      riverId: raw.riverId,
      deckElevationM: raw.deckElevationM,
      towerHeightM: raw.towerHeightM,
      widthM: raw.widthM,
      color: raw.color,
      spanEnu: [p0, p1],
      deckPointsEnu,
      towersEnu,
      centroidEnu,
    };
  });

  return { waterBodies, boroughs, bridges };
}

export const LANDMARKS: LandmarkDataset = createLandmarks();
