export type IncidentType =
  | 'water_rescue'
  | 'vehicle_in_water'
  | 'cardiac_arrest'
  | 'breathing'
  | 'chest_pain'
  | 'stroke'
  | 'medical_dependency'
  | 'injury'
  | 'fire'
  | 'gas_leak'
  | 'crime'
  | 'welfare'
  | 'info';

export const INCIDENT_TYPES: IncidentType[] = [
  'water_rescue',
  'vehicle_in_water',
  'cardiac_arrest',
  'breathing',
  'chest_pain',
  'stroke',
  'medical_dependency',
  'injury',
  'fire',
  'gas_leak',
  'crime',
  'welfare',
  'info',
];

export const TYPE_LABEL: Record<IncidentType, string> = {
  water_rescue: 'Trapped by floodwater',
  vehicle_in_water: 'Vehicle in water',
  cardiac_arrest: 'Cardiac arrest',
  breathing: 'Breathing problem',
  chest_pain: 'Chest pain',
  stroke: 'Stroke',
  medical_dependency: 'Life-support / dialysis',
  injury: 'Injury',
  fire: 'Fire',
  gas_leak: 'Gas leak',
  crime: 'Crime in progress',
  welfare: 'Welfare check',
  info: 'Non-emergency',
};

export type UnitKind = 'medic' | 'engine' | 'rescue' | 'police';

/** Which units can resolve each incident type, best first. Non-emergency calls get no unit. */
export const CAN_SERVE: Record<IncidentType, UnitKind[]> = {
  water_rescue: ['rescue', 'engine'],
  vehicle_in_water: ['rescue', 'engine'],
  // fire engines carry EMTs and a defibrillator; a boat crew can reach a patient no ambulance can
  cardiac_arrest: ['medic', 'engine', 'rescue'],
  breathing: ['medic', 'engine', 'rescue'],
  chest_pain: ['medic', 'engine', 'rescue'],
  stroke: ['medic', 'engine', 'rescue'],
  medical_dependency: ['medic', 'engine', 'rescue'],
  injury: ['medic', 'engine', 'rescue'],
  fire: ['engine'],
  gas_leak: ['engine'],
  crime: ['police'],
  welfare: ['police', 'engine'],
  info: [],
};

/** Standard dispatch protocol priority (1 = emergent). This is what a conventional CAD queue sorts by. */
export const PROTOCOL_PRIORITY: Record<IncidentType, 1 | 2 | 3> = {
  water_rescue: 1,
  vehicle_in_water: 1,
  cardiac_arrest: 1,
  fire: 1,
  breathing: 2,
  chest_pain: 2,
  stroke: 2,
  medical_dependency: 2,
  injury: 2,
  gas_leak: 2,
  crime: 2,
  welfare: 3,
  info: 3,
};

export interface Vulnerability {
  elderly: boolean;
  infant: boolean;
  mobility: boolean;
  medical: boolean;
}

/** Ground truth for one emergency. The dispatcher never sees this directly, only the calls about it. */
export interface Incident {
  id: number;
  type: IncidentType;
  /** Minute the emergency starts. */
  t0: number;
  address: number;
  x: number;
  y: number;
  node: number;
  people: number;
  vuln: Vulnerability;
  /** Scenario-specific severity scale in [0.5, 1.5] that shifts the hazard. */
  severity: number;
}

export interface Call {
  id: number;
  incident: number;
  /** Minute the phone rings. */
  t: number;
  /** Caller's phone number (ANI); a repeat caller keeps the same one. */
  phone: string;
  /** Wireless location estimate (ALI) and its uncertainty radius in meters. */
  aliX: number;
  aliY: number;
  aliR: number;
  transcript: string;
  /** Whether the caller said the address out loud (a human call-taker would then have it right). */
  addressGiven: boolean;
  /** How long this caller will wait on hold before hanging up (minutes). */
  patience: number;
  /** Nth call about this incident from this phone. */
  attempt: number;
  thirdParty: boolean;
}
