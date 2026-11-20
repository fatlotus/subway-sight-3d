import { wgs84ToEnu } from '../geo/projection';
import type {
  BoroughName,
  GpsVisibility,
  RailSystem,
  Station,
  StructureType,
} from '../types/transit';

interface RawStation {
  id: string;
  name: string;
  system: RailSystem;
  lat: number;
  lon: number;
  elevM: number;
  routes: string[];
  structure: StructureType;
  gpsVisibility: GpsVisibility;
  borough: BoroughName;
  isExpressStop?: boolean;
  isHub?: boolean;
}

const RAW_STATIONS: readonly RawStation[] = [
  // =========================================================================
  // MTA 1/2/3 — IRT Broadway–7th Ave
  // =========================================================================
  { id: 'mta-south-ferry', name: 'South Ferry', system: 'MTA', lat: 40.7021, lon: -74.0137, elevM: -16, routes: ['1'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-wtc-cortlandt', name: 'WTC Cortlandt', system: 'MTA', lat: 40.7118, lon: -74.0122, elevM: -16, routes: ['1'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-chambers-123', name: 'Chambers St', system: 'MTA', lat: 40.7155, lon: -74.0093, elevM: -16, routes: ['1', '2', '3'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true },
  { id: 'mta-14st-123', name: '14th St', system: 'MTA', lat: 40.7378, lon: -74.0002, elevM: -16, routes: ['1', '2', '3'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true },
  { id: 'mta-34st-penn-123', name: '34th St–Penn Station', system: 'MTA', lat: 40.7504, lon: -73.9911, elevM: -16, routes: ['1', '2', '3'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true, isHub: true },
  { id: 'mta-times-sq-123', name: 'Times Sq–42nd St', system: 'MTA', lat: 40.7553, lon: -73.9875, elevM: -16, routes: ['1', '2', '3'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true, isHub: true },
  { id: 'mta-72st-123', name: '72nd St', system: 'MTA', lat: 40.7785, lon: -73.9820, elevM: -16, routes: ['1', '2', '3'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true },
  { id: 'mta-96st-123', name: '96th St', system: 'MTA', lat: 40.7939, lon: -73.9723, elevM: -16, routes: ['1', '2', '3'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true },
  { id: 'mta-116st-columbia', name: '116th St–Columbia Univ', system: 'MTA', lat: 40.8077, lon: -73.9641, elevM: -14, routes: ['1'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-125st-1', name: '125th St (Broadway Viaduct)', system: 'MTA', lat: 40.8156, lon: -73.9584, elevM: 16, routes: ['1'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'Manhattan' },
  { id: 'mta-168st-1', name: '168th St', system: 'MTA', lat: 40.8406, lon: -73.9401, elevM: -40, routes: ['1'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-191st-1', name: '191st St', system: 'MTA', lat: 40.8552, lon: -73.9294, elevM: -55, routes: ['1'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-atlantic-barclays', name: 'Atlantic Ave–Barclays Ctr', system: 'MTA', lat: 40.6844, lon: -73.9777, elevM: -16, routes: ['2', '3', '4', '5', 'B', 'D', 'N', 'Q', 'R'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Brooklyn', isExpressStop: true, isHub: true },
  { id: 'mta-borough-hall', name: 'Borough Hall', system: 'MTA', lat: 40.6932, lon: -73.9900, elevM: -17, routes: ['2', '3', '4', '5'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Brooklyn', isHub: true },
  { id: 'mta-clark-st', name: 'Clark St', system: 'MTA', lat: 40.6975, lon: -73.9931, elevM: -24, routes: ['2', '3'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Brooklyn' },
  { id: 'mta-wall-st-23', name: 'Wall St (William St)', system: 'MTA', lat: 40.7068, lon: -74.0091, elevM: -17, routes: ['2', '3'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-fulton-23', name: 'Fulton St (2/3)', system: 'MTA', lat: 40.7094, lon: -74.0066, elevM: -17, routes: ['2', '3'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isHub: true },
  { id: 'mta-110st-cpn', name: 'Central Park North–110th St', system: 'MTA', lat: 40.7991, lon: -73.9518, elevM: -16, routes: ['2', '3'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-125st-23', name: '125th St (Lenox Ave)', system: 'MTA', lat: 40.8078, lon: -73.9455, elevM: -16, routes: ['2', '3'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-149st-gc', name: '149th St–Grand Concourse', system: 'MTA', lat: 40.8184, lon: -73.9273, elevM: -16, routes: ['2', '4', '5'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Bronx', isHub: true },

  // =========================================================================
  // MTA 4/5/6 — IRT Lexington Ave (Bi-Level: Local -11/-12m, Express -20/-23m)
  // =========================================================================
  { id: 'mta-bowling-green', name: 'Bowling Green', system: 'MTA', lat: 40.7048, lon: -74.0141, elevM: -23, routes: ['4', '5'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-wall-st-45', name: 'Wall St (Broadway)', system: 'MTA', lat: 40.7076, lon: -74.0119, elevM: -23, routes: ['4', '5'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-fulton-45', name: 'Fulton St (4/5)', system: 'MTA', lat: 40.7104, lon: -74.0095, elevM: -23, routes: ['4', '5'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isHub: true },
  { id: 'mta-bklyn-bridge-city-hall', name: 'Brooklyn Bridge–City Hall', system: 'MTA', lat: 40.7131, lon: -74.0041, elevM: -11, routes: ['4', '5', '6'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true, isHub: true },
  { id: 'mta-canal-6', name: 'Canal St (Lexington)', system: 'MTA', lat: 40.7188, lon: -74.0002, elevM: -11, routes: ['6'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-bleecker-6', name: 'Bleecker St', system: 'MTA', lat: 40.7259, lon: -73.9947, elevM: -11, routes: ['6'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-union-sq-456', name: '14th St–Union Sq (Lex)', system: 'MTA', lat: 40.7347, lon: -73.9899, elevM: -11, routes: ['4', '5', '6'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true, isHub: true },
  { id: 'mta-23st-6', name: '23rd St (Lex)', system: 'MTA', lat: 40.7399, lon: -73.9866, elevM: -12, routes: ['6'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-33st-6', name: '33rd St (Lex)', system: 'MTA', lat: 40.7461, lon: -73.9821, elevM: -12, routes: ['6'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-grand-central-456', name: 'Grand Central–42nd St', system: 'MTA', lat: 40.7518, lon: -73.9768, elevM: -12, routes: ['4', '5', '6'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true, isHub: true },
  { id: 'mta-51st-6', name: '51st St', system: 'MTA', lat: 40.7571, lon: -73.9719, elevM: -12, routes: ['6'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-59st-456', name: '59th St (Lex)', system: 'MTA', lat: 40.7625, lon: -73.9680, elevM: -11, routes: ['4', '5', '6'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true },
  { id: 'mta-86st-456', name: '86th St (Lex)', system: 'MTA', lat: 40.7795, lon: -73.9556, elevM: -11, routes: ['4', '5', '6'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true },
  { id: 'mta-125st-456', name: '125th St (Lex)', system: 'MTA', lat: 40.8041, lon: -73.9376, elevM: -11, routes: ['4', '5', '6'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true, isHub: true },
  { id: 'mta-138st-gc', name: '138th St–Grand Concourse', system: 'MTA', lat: 40.8132, lon: -73.9298, elevM: -14, routes: ['4', '5'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Bronx' },
  { id: 'mta-161st-yankee', name: '161st St–Yankee Stadium', system: 'MTA', lat: 40.8280, lon: -73.9258, elevM: 12, routes: ['4', 'B', 'D'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'Bronx', isHub: true },

  // =========================================================================
  // MTA 7 — IRT Flushing
  // =========================================================================
  { id: 'mta-hudson-yards-7', name: '34th St–Hudson Yards', system: 'MTA', lat: 40.7559, lon: -74.0019, elevM: -34, routes: ['7'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-times-sq-7', name: 'Times Sq–42nd St (7)', system: 'MTA', lat: 40.7555, lon: -73.9870, elevM: -28, routes: ['7'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isHub: true },
  { id: 'mta-5ave-bryant-7', name: '5th Ave–Bryant Park', system: 'MTA', lat: 40.7538, lon: -73.9820, elevM: -28, routes: ['7'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-grand-central-7', name: 'Grand Central–42nd St (7)', system: 'MTA', lat: 40.7514, lon: -73.9761, elevM: -28, routes: ['7'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isHub: true },
  { id: 'mta-vernon-jackson-7', name: 'Vernon Blvd–Jackson Ave', system: 'MTA', lat: 40.7426, lon: -73.9536, elevM: -14, routes: ['7'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Queens' },
  { id: 'mta-hunters-pt-7', name: 'Hunters Point Ave', system: 'MTA', lat: 40.7422, lon: -73.9489, elevM: -10, routes: ['7'], structure: 'STATION', gpsVisibility: 'PORTAL', borough: 'Queens' },
  { id: 'mta-court-sq-7', name: 'Court Sq (7)', system: 'MTA', lat: 40.7470, lon: -73.9453, elevM: 12, routes: ['7'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'Queens', isHub: true },
  { id: 'mta-queensboro-plaza-7', name: 'Queensboro Plaza (7)', system: 'MTA', lat: 40.7506, lon: -73.9402, elevM: 16, routes: ['7'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'Queens', isHub: true },
  { id: 'mta-woodside-61-7', name: '61st St–Woodside', system: 'MTA', lat: 40.7456, lon: -73.9030, elevM: 15, routes: ['7'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'Queens', isExpressStop: true, isHub: true },
  { id: 'mta-junction-blvd-7', name: 'Junction Blvd', system: 'MTA', lat: 40.7491, lon: -73.8695, elevM: 14, routes: ['7'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'Queens', isExpressStop: true },
  { id: 'mta-flushing-main-7', name: 'Flushing–Main St', system: 'MTA', lat: 40.7596, lon: -73.8300, elevM: -10, routes: ['7'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Queens', isHub: true },

  // =========================================================================
  // MTA A/C/E — IND 8th Ave
  // =========================================================================
  { id: 'mta-jay-st-metrotech', name: 'Jay St–MetroTech', system: 'MTA', lat: 40.6923, lon: -73.9873, elevM: -12, routes: ['A', 'C', 'F', 'R'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Brooklyn', isHub: true },
  { id: 'mta-high-st-ac', name: 'High St–Brooklyn Bridge', system: 'MTA', lat: 40.6993, lon: -73.9905, elevM: -18, routes: ['A', 'C'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Brooklyn' },
  { id: 'mta-fulton-ac', name: 'Fulton St (A/C)', system: 'MTA', lat: 40.7102, lon: -74.0076, elevM: -12, routes: ['A', 'C'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isHub: true },
  { id: 'mta-chambers-wtc-ace', name: 'Chambers St–WTC', system: 'MTA', lat: 40.7141, lon: -74.0086, elevM: -12, routes: ['A', 'C', 'E'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true, isHub: true },
  { id: 'mta-canal-ace', name: 'Canal St (8th Ave)', system: 'MTA', lat: 40.7208, lon: -74.0052, elevM: -11, routes: ['A', 'C', 'E'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true },
  { id: 'mta-spring-ce', name: 'Spring St (8th Ave)', system: 'MTA', lat: 40.7262, lon: -74.0037, elevM: -11, routes: ['C', 'E'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-w4st-ace', name: 'W 4th St–Wash Sq (8th Ave)', system: 'MTA', lat: 40.7323, lon: -74.0005, elevM: -11, routes: ['A', 'C', 'E'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true, isHub: true },
  { id: 'mta-14st-ace', name: '14th St (8th Ave)', system: 'MTA', lat: 40.7409, lon: -74.0017, elevM: -11, routes: ['A', 'C', 'E'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true },
  { id: 'mta-23st-ce', name: '23rd St (8th Ave)', system: 'MTA', lat: 40.7459, lon: -73.9980, elevM: -11, routes: ['C', 'E'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-34st-penn-ace', name: '34th St–Penn Station (8th Ave)', system: 'MTA', lat: 40.7523, lon: -73.9934, elevM: -11, routes: ['A', 'C', 'E'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true, isHub: true },
  { id: 'mta-42st-pabt-ace', name: '42nd St–Port Authority', system: 'MTA', lat: 40.7573, lon: -73.9897, elevM: -11, routes: ['A', 'C', 'E'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true, isHub: true },
  { id: 'mta-50st-ce', name: '50th St (8th Ave)', system: 'MTA', lat: 40.7625, lon: -73.9860, elevM: -11, routes: ['C', 'E'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-59st-columbus-ac', name: '59th St–Columbus Circle', system: 'MTA', lat: 40.7683, lon: -73.9817, elevM: -11, routes: ['A', 'B', 'C', 'D'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true, isHub: true },
  { id: 'mta-72st-c', name: '72nd St (Central Park W)', system: 'MTA', lat: 40.7756, lon: -73.9764, elevM: -11, routes: ['B', 'C'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-81st-museum', name: '81st St–Museum of Nat Hist', system: 'MTA', lat: 40.7814, lon: -73.9721, elevM: -11, routes: ['B', 'C'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-125st-ac', name: '125th St (St Nicholas)', system: 'MTA', lat: 40.8111, lon: -73.9523, elevM: -12, routes: ['A', 'B', 'C', 'D'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true, isHub: true },
  { id: 'mta-145st-ac', name: '145th St (St Nicholas)', system: 'MTA', lat: 40.8248, lon: -73.9442, elevM: -14, routes: ['A', 'B', 'C', 'D'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true },
  { id: 'mta-5ave-53-em', name: '5th Ave / 53rd St', system: 'MTA', lat: 40.7602, lon: -73.9752, elevM: -28, routes: ['E', 'M'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-lex-53-em', name: 'Lexington Ave / 53rd St', system: 'MTA', lat: 40.7576, lon: -73.9691, elevM: -28, routes: ['E', 'M'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isHub: true },
  { id: 'mta-court-sq-23-em', name: 'Court Sq–23rd St (E/M)', system: 'MTA', lat: 40.7478, lon: -73.9460, elevM: -14, routes: ['E', 'M'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Queens' },
  { id: 'mta-jackson-hts-roosevelt', name: 'Jackson Hts–Roosevelt Ave', system: 'MTA', lat: 40.7466, lon: -73.8913, elevM: -14, routes: ['E', 'F', 'M', 'R'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Queens', isExpressStop: true, isHub: true },
  { id: 'mta-forest-hills-71', name: 'Forest Hills–71st Ave', system: 'MTA', lat: 40.7217, lon: -73.8445, elevM: -14, routes: ['E', 'F', 'M', 'R'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Queens', isExpressStop: true },
  { id: 'mta-jamaica-center', name: 'Jamaica Center–Parsons/Archer', system: 'MTA', lat: 40.7021, lon: -73.8011, elevM: -16, routes: ['E', 'J', 'Z'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Queens', isHub: true },

  // =========================================================================
  // MTA B/D/F/M — IND 6th Ave
  // =========================================================================
  { id: 'mta-dekalb-ave', name: 'DeKalb Ave', system: 'MTA', lat: 40.6906, lon: -73.9818, elevM: -14, routes: ['B', 'D', 'N', 'Q', 'R'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Brooklyn', isHub: true },
  { id: 'mta-grand-st-bd', name: 'Grand St', system: 'MTA', lat: 40.7183, lon: -73.9938, elevM: -17, routes: ['B', 'D'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-york-st-f', name: 'York St', system: 'MTA', lat: 40.7014, lon: -73.9868, elevM: -22, routes: ['F'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Brooklyn' },
  { id: 'mta-east-broadway-f', name: 'East Broadway', system: 'MTA', lat: 40.7137, lon: -73.9902, elevM: -25, routes: ['F'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-delancey-f', name: 'Delancey St–Essex St (F)', system: 'MTA', lat: 40.7186, lon: -73.9881, elevM: -25, routes: ['F'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isHub: true },
  { id: 'mta-bway-lafayette', name: 'Broadway–Lafayette St', system: 'MTA', lat: 40.7253, lon: -73.9962, elevM: -27, routes: ['B', 'D', 'F', 'M'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isHub: true },
  { id: 'mta-w4st-bdfm', name: 'W 4th St–Wash Sq (6th Ave)', system: 'MTA', lat: 40.7323, lon: -74.0005, elevM: -22, routes: ['B', 'D', 'F', 'M'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true, isHub: true },
  { id: 'mta-14st-fm', name: '14th St (6th Ave)', system: 'MTA', lat: 40.7382, lon: -73.9962, elevM: -21, routes: ['F', 'M'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-23st-fm', name: '23rd St (6th Ave)', system: 'MTA', lat: 40.7429, lon: -73.9928, elevM: -21, routes: ['F', 'M'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-herald-sq-bdfm', name: '34th St–Herald Sq (6th Ave)', system: 'MTA', lat: 40.7497, lon: -73.9878, elevM: -22, routes: ['B', 'D', 'F', 'M'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true, isHub: true },
  { id: 'mta-bryant-park-bdfm', name: '42nd St–Bryant Park', system: 'MTA', lat: 40.7542, lon: -73.9846, elevM: -22, routes: ['B', 'D', 'F', 'M'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true, isHub: true },
  { id: 'mta-rockefeller-bdfm', name: '47–50th Sts–Rockefeller Ctr', system: 'MTA', lat: 40.7587, lon: -73.9813, elevM: -22, routes: ['B', 'D', 'F', 'M'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true },
  { id: 'mta-7ave-bd', name: '7th Ave (53rd St)', system: 'MTA', lat: 40.7629, lon: -73.9816, elevM: -22, routes: ['B', 'D', 'E'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-57st-f', name: '57th St (6th Ave)', system: 'MTA', lat: 40.7640, lon: -73.9774, elevM: -24, routes: ['F'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-lex-63-f', name: 'Lexington Ave / 63rd St (F)', system: 'MTA', lat: 40.7646, lon: -73.9661, elevM: -38, routes: ['F'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isHub: true },
  { id: 'mta-roosevelt-island', name: 'Roosevelt Island', system: 'MTA', lat: 40.7591, lon: -73.9533, elevM: -26, routes: ['F'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-21st-queensbridge', name: '21st St–Queensbridge', system: 'MTA', lat: 40.7542, lon: -73.9428, elevM: -15, routes: ['F'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Queens' },

  // =========================================================================
  // MTA N/Q/R/W — BMT Broadway
  // =========================================================================
  { id: 'mta-church-ave-q', name: 'Church Ave (Brighton)', system: 'MTA', lat: 40.6508, lon: -73.9629, elevM: -6, routes: ['B', 'Q'], structure: 'OPEN_CUT', gpsVisibility: 'OPEN_SKY', borough: 'Brooklyn' },
  { id: 'mta-prospect-park-q', name: 'Prospect Park', system: 'MTA', lat: 40.6616, lon: -73.9622, elevM: -6, routes: ['B', 'Q'], structure: 'OPEN_CUT', gpsVisibility: 'OPEN_SKY', borough: 'Brooklyn' },
  { id: 'mta-court-st-r', name: 'Court St', system: 'MTA', lat: 40.6941, lon: -73.9918, elevM: -20, routes: ['R'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Brooklyn' },
  { id: 'mta-whitehall-rw', name: 'Whitehall St–South Ferry', system: 'MTA', lat: 40.7031, lon: -74.0130, elevM: -6, routes: ['R', 'W'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-cortlandt-rw', name: 'Cortlandt St', system: 'MTA', lat: 40.7107, lon: -74.0110, elevM: -6, routes: ['R', 'W'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-city-hall-rw', name: 'City Hall', system: 'MTA', lat: 40.7133, lon: -74.0070, elevM: -6, routes: ['R', 'W'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-canal-nqrw', name: 'Canal St (Broadway)', system: 'MTA', lat: 40.7195, lon: -74.0018, elevM: -17, routes: ['N', 'Q', 'R', 'W'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true, isHub: true },
  { id: 'mta-union-sq-nqrw', name: '14th St–Union Sq (Broadway)', system: 'MTA', lat: 40.7357, lon: -73.9906, elevM: -18, routes: ['N', 'Q', 'R', 'W'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true, isHub: true },
  { id: 'mta-23st-rw', name: '23rd St (Broadway)', system: 'MTA', lat: 40.7413, lon: -73.9893, elevM: -12, routes: ['R', 'W'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-herald-sq-nqrw', name: '34th St–Herald Sq (Broadway)', system: 'MTA', lat: 40.7496, lon: -73.9879, elevM: -10, routes: ['N', 'Q', 'R', 'W'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true, isHub: true },
  { id: 'mta-times-sq-nqrw', name: 'Times Sq–42nd St (Broadway)', system: 'MTA', lat: 40.7547, lon: -73.9867, elevM: -10, routes: ['N', 'Q', 'R', 'W'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true, isHub: true },
  { id: 'mta-49st-rw', name: '49th St', system: 'MTA', lat: 40.7599, lon: -73.9841, elevM: -10, routes: ['N', 'R', 'W'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-57st-7ave-nqrw', name: '57th St–7th Ave', system: 'MTA', lat: 40.7647, lon: -73.9807, elevM: -10, routes: ['N', 'Q', 'R', 'W'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isExpressStop: true },
  { id: 'mta-5ave-59-nrw', name: '5th Ave / 59th St', system: 'MTA', lat: 40.7648, lon: -73.9733, elevM: -16, routes: ['N', 'R', 'W'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-lex-59-nrw', name: 'Lexington Ave / 59th St', system: 'MTA', lat: 40.7626, lon: -73.9673, elevM: -30, routes: ['N', 'R', 'W'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isHub: true },
  { id: 'mta-queensboro-plaza-nw', name: 'Queensboro Plaza (N/W)', system: 'MTA', lat: 40.7506, lon: -73.9402, elevM: 11, routes: ['N', 'W'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'Queens', isHub: true },
  { id: 'mta-astoria-ditmars', name: 'Astoria–Ditmars Blvd', system: 'MTA', lat: 40.7750, lon: -73.9120, elevM: 12, routes: ['N', 'W'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'Queens' },
  { id: 'mta-lex-63-q', name: 'Lexington Ave / 63rd St (Q)', system: 'MTA', lat: 40.7646, lon: -73.9661, elevM: -30, routes: ['Q'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-72st-q', name: '72nd St (2nd Ave)', system: 'MTA', lat: 40.7688, lon: -73.9584, elevM: -26, routes: ['Q'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-86st-q', name: '86th St (2nd Ave)', system: 'MTA', lat: 40.7779, lon: -73.9518, elevM: -26, routes: ['Q'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-96st-q', name: '96th St (2nd Ave)', system: 'MTA', lat: 40.7843, lon: -73.9472, elevM: -24, routes: ['Q'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },

  // =========================================================================
  // MTA L — BMT Canarsie
  // =========================================================================
  { id: 'mta-8ave-14-l', name: '8th Ave–14th St (L)', system: 'MTA', lat: 40.7398, lon: -74.0026, elevM: -27, routes: ['L'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-6ave-14-l', name: '6th Ave–14th St (L)', system: 'MTA', lat: 40.7373, lon: -73.9968, elevM: -27, routes: ['L'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-union-sq-l', name: '14th St–Union Sq (L)', system: 'MTA', lat: 40.7348, lon: -73.9907, elevM: -27, routes: ['L'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isHub: true },
  { id: 'mta-1ave-14-l', name: '1st Ave (L)', system: 'MTA', lat: 40.7309, lon: -73.9816, elevM: -27, routes: ['L'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-bedford-ave-l', name: 'Bedford Ave', system: 'MTA', lat: 40.7173, lon: -73.9569, elevM: -14, routes: ['L'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Brooklyn' },
  { id: 'mta-lorimer-l', name: 'Lorimer St', system: 'MTA', lat: 40.7141, lon: -73.9503, elevM: -14, routes: ['L'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Brooklyn' },
  { id: 'mta-myrtle-wyckoff-l', name: 'Myrtle–Wyckoff Aves', system: 'MTA', lat: 40.6998, lon: -73.9116, elevM: -12, routes: ['L', 'M'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Brooklyn' },
  { id: 'mta-broadway-jct-l', name: 'Broadway Junction (L)', system: 'MTA', lat: 40.6789, lon: -73.9032, elevM: 12, routes: ['L'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'Brooklyn', isHub: true },

  // =========================================================================
  // MTA G — IND Crosstown
  // =========================================================================
  { id: 'mta-court-sq-g', name: 'Court Sq (G)', system: 'MTA', lat: 40.7466, lon: -73.9438, elevM: -14, routes: ['G'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Queens', isHub: true },
  { id: 'mta-greenpoint-g', name: 'Greenpoint Ave', system: 'MTA', lat: 40.7314, lon: -73.9544, elevM: -14, routes: ['G'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Brooklyn' },
  { id: 'mta-metropolitan-g', name: 'Metropolitan Ave (G)', system: 'MTA', lat: 40.7128, lon: -73.9514, elevM: -21, routes: ['G'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Brooklyn' },
  { id: 'mta-hoyt-schermerhorn-g', name: 'Hoyt–Schermerhorn Sts', system: 'MTA', lat: 40.6885, lon: -73.9850, elevM: -21, routes: ['A', 'C', 'G'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Brooklyn' },
  { id: 'mta-smith-9th-g', name: 'Smith–9th Sts', system: 'MTA', lat: 40.6736, lon: -73.9959, elevM: 27, routes: ['F', 'G'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'Brooklyn' },
  { id: 'mta-church-ave-g', name: 'Church Ave (Culver)', system: 'MTA', lat: 40.6440, lon: -73.9797, elevM: -12, routes: ['F', 'G'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Brooklyn' },

  // =========================================================================
  // MTA J/Z — BMT Nassau
  // =========================================================================
  { id: 'mta-broad-st-jz', name: 'Broad St', system: 'MTA', lat: 40.7065, lon: -74.0111, elevM: -29, routes: ['J', 'Z'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-fulton-jz', name: 'Fulton St (J/Z)', system: 'MTA', lat: 40.7104, lon: -74.0079, elevM: -29, routes: ['J', 'Z'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isHub: true },
  { id: 'mta-chambers-jz', name: 'Chambers St (Nassau)', system: 'MTA', lat: 40.7132, lon: -74.0034, elevM: -29, routes: ['J', 'Z'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'mta-essex-st-jz', name: 'Essex St', system: 'MTA', lat: 40.7183, lon: -73.9874, elevM: -10, routes: ['J', 'M', 'Z'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isHub: true },
  { id: 'mta-marcy-ave-jz', name: 'Marcy Ave', system: 'MTA', lat: 40.7084, lon: -73.9578, elevM: 12, routes: ['J', 'M', 'Z'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'Brooklyn' },
  { id: 'mta-myrtle-ave-jz', name: 'Myrtle Ave (Broadway)', system: 'MTA', lat: 40.6972, lon: -73.9357, elevM: 12, routes: ['J', 'M', 'Z'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'Brooklyn' },
  { id: 'mta-broadway-jct-jz', name: 'Broadway Junction (J/Z)', system: 'MTA', lat: 40.6794, lon: -73.9045, elevM: 18, routes: ['J', 'Z'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'Brooklyn', isHub: true },

  // =========================================================================
  // REGIONAL RAIL — LIRR
  // =========================================================================
  { id: 'lirr-penn-station', name: 'Penn Station (LIRR)', system: 'LIRR', lat: 40.7506, lon: -73.9935, elevM: -30, routes: ['LIRR-MAIN'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isHub: true },
  { id: 'lirr-gcm', name: 'Grand Central Madison', system: 'LIRR', lat: 40.7527, lon: -73.9772, elevM: -48, routes: ['LIRR-GCM'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isHub: true },
  { id: 'lirr-atlantic-terminal', name: 'Atlantic Terminal', system: 'LIRR', lat: 40.6845, lon: -73.9767, elevM: -8, routes: ['LIRR-ATL'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Brooklyn', isHub: true },
  { id: 'lirr-woodside', name: 'Woodside (LIRR)', system: 'LIRR', lat: 40.7458, lon: -73.9032, elevM: 8, routes: ['LIRR-MAIN', 'LIRR-GCM'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'Queens', isHub: true },
  { id: 'lirr-jamaica', name: 'Jamaica (LIRR)', system: 'LIRR', lat: 40.7000, lon: -73.8080, elevM: 8, routes: ['LIRR-MAIN', 'LIRR-GCM', 'LIRR-ATL'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'Queens', isHub: true },

  // =========================================================================
  // REGIONAL RAIL — MNR (Metro-North)
  // =========================================================================
  { id: 'mnr-grand-central', name: 'Grand Central Terminal', system: 'MNR', lat: 40.7527, lon: -73.9772, elevM: -8, routes: ['MNR-HARLEM'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isHub: true },
  { id: 'mnr-harlem-125', name: 'Harlem–125th St', system: 'MNR', lat: 40.8053, lon: -73.9391, elevM: 10, routes: ['MNR-HARLEM'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'Manhattan', isHub: true },
  { id: 'mnr-melrose', name: 'Melrose', system: 'MNR', lat: 40.8256, lon: -73.9154, elevM: 6, routes: ['MNR-HARLEM'], structure: 'OPEN_CUT', gpsVisibility: 'OPEN_SKY', borough: 'Bronx' },

  // =========================================================================
  // REGIONAL RAIL — PATH
  // =========================================================================
  { id: 'path-33st', name: '33rd St (PATH)', system: 'PATH', lat: 40.7484, lon: -73.9886, elevM: -14, routes: ['PATH-HOB'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isHub: true },
  { id: 'path-14st', name: '14th St (PATH)', system: 'PATH', lat: 40.7374, lon: -73.9968, elevM: -14, routes: ['PATH-HOB'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'path-christopher', name: 'Christopher St (PATH)', system: 'PATH', lat: 40.7329, lon: -74.0071, elevM: -24, routes: ['PATH-HOB'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan' },
  { id: 'path-hoboken', name: 'Hoboken Terminal', system: 'PATH', lat: 40.7350, lon: -74.0292, elevM: -6, routes: ['PATH-HOB'], structure: 'STATION', gpsVisibility: 'PORTAL', borough: 'New Jersey', isHub: true },
  { id: 'path-wtc', name: 'World Trade Center (PATH)', system: 'PATH', lat: 40.7116, lon: -74.0113, elevM: -22, routes: ['PATH-NWK'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isHub: true },
  { id: 'path-exchange-pl', name: 'Exchange Place', system: 'PATH', lat: 40.7168, lon: -74.0323, elevM: -18, routes: ['PATH-NWK'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'New Jersey' },
  { id: 'path-journal-sq', name: 'Journal Square', system: 'PATH', lat: 40.7330, lon: -74.0628, elevM: -4, routes: ['PATH-NWK'], structure: 'OPEN_CUT', gpsVisibility: 'OPEN_SKY', borough: 'New Jersey', isHub: true },
  { id: 'path-newark-penn', name: 'Newark Penn Station (PATH)', system: 'PATH', lat: 40.7353, lon: -74.1642, elevM: 11, routes: ['PATH-NWK'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'New Jersey', isHub: true },

  // =========================================================================
  // REGIONAL RAIL — NJT (NJ Transit)
  // =========================================================================
  { id: 'njt-penn-station', name: 'New York Penn Station (NJT)', system: 'NJT', lat: 40.7506, lon: -73.9935, elevM: -30, routes: ['NJT-NEC'], structure: 'STATION', gpsVisibility: 'UNDERGROUND', borough: 'Manhattan', isHub: true },
  { id: 'njt-secaucus', name: 'Secaucus Junction', system: 'NJT', lat: 40.7614, lon: -74.0758, elevM: 4, routes: ['NJT-NEC'], structure: 'AT_GRADE', gpsVisibility: 'OPEN_SKY', borough: 'New Jersey', isHub: true },
  { id: 'njt-newark-penn', name: 'Newark Penn Station (NJT)', system: 'NJT', lat: 40.7347, lon: -74.1642, elevM: 6, routes: ['NJT-NEC'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'New Jersey', isHub: true },
  { id: 'njt-ewr-station', name: 'Newark Liberty Airport Station', system: 'NJT', lat: 40.7044, lon: -74.1907, elevM: 4, routes: ['NJT-NEC'], structure: 'AT_GRADE', gpsVisibility: 'OPEN_SKY', borough: 'New Jersey', isHub: true },

  // =========================================================================
  // REGIONAL RAIL — AIRTRAIN (JFK & EWR)
  // =========================================================================
  { id: 'airtrain-jfk-jamaica', name: 'Jamaica Station (AirTrain JFK)', system: 'AIRTRAIN', lat: 40.6997, lon: -73.8085, elevM: 14, routes: ['AIRTRAIN-JFK'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'Queens', isHub: true },
  { id: 'airtrain-jfk-federal', name: 'Federal Circle', system: 'AIRTRAIN', lat: 40.6600, lon: -73.8034, elevM: 12, routes: ['AIRTRAIN-JFK'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'Queens' },
  { id: 'airtrain-jfk-t4', name: 'JFK Terminal 4', system: 'AIRTRAIN', lat: 40.6441, lon: -73.7824, elevM: 12, routes: ['AIRTRAIN-JFK'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'Queens' },
  { id: 'airtrain-ewr-station', name: 'Newark Airport Rail Station (AirTrain)', system: 'AIRTRAIN', lat: 40.7044, lon: -74.1907, elevM: 10, routes: ['AIRTRAIN-EWR'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'New Jersey' },
  { id: 'airtrain-ewr-tc', name: 'EWR Terminal C', system: 'AIRTRAIN', lat: 40.6960, lon: -74.1773, elevM: 10, routes: ['AIRTRAIN-EWR'], structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY', borough: 'New Jersey' },
];

export function createStations(): Station[] {
  return RAW_STATIONS.map((raw) => ({
    ...raw,
    routes: [...raw.routes],
    enu: wgs84ToEnu(raw.lat, raw.lon, raw.elevM),
  }));
}

export const STATIONS: Station[] = createStations();
