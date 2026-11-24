export const UserRole = {
  JEFE_STOCK: 'JEFE_STOCK',
  CONTADOR: 'CONTADOR',
  RESPONSABLE_DEPOSITO: 'RESPONSABLE_DEPOSITO',
  AUDITORIA_DIRECCION: 'AUDITORIA_DIRECCION',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const LocationGroup = {
  CASA_CENTRAL: 'CASA_CENTRAL',
  SUCURSAL: 'SUCURSAL',
} as const;
export type LocationGroup = (typeof LocationGroup)[keyof typeof LocationGroup];

export const CriticalityLevel = {
  ALTA: 'ALTA',
  MEDIA: 'MEDIA',
  BAJA: 'BAJA',
} as const;
export type CriticalityLevel = (typeof CriticalityLevel)[keyof typeof CriticalityLevel];

export const RiskTier = {
  CRITICO: 'CRITICO',
  ALTO: 'ALTO',
  MEDIO: 'MEDIO',
  BAJO: 'BAJO',
} as const;
export type RiskTier = (typeof RiskTier)[keyof typeof RiskTier];

export const CountStatus = {
  EJECUCION: 'EJECUCION',
  ENTREGADO: 'ENTREGADO',
  APROBADO: 'APROBADO',
  RECHAZADO: 'RECHAZADO',
} as const;
export type CountStatus = (typeof CountStatus)[keyof typeof CountStatus];

export const ReconciliationResult = {
  COINCIDENCIA: 'COINCIDENCIA',
  FALTANTE: 'FALTANTE',
  SOBRANTE: 'SOBRANTE',
} as const;
export type ReconciliationResult =
  (typeof ReconciliationResult)[keyof typeof ReconciliationResult];

export const AdjustmentOperationType = {
  PENDIENTE: 'PENDIENTE',
  AJUSTE: 'AJUSTE',
  MOVIMIENTO: 'MOVIMIENTO',
  SIN_AJUSTE: 'SIN_AJUSTE',
} as const;
export type AdjustmentOperationType =
  (typeof AdjustmentOperationType)[keyof typeof AdjustmentOperationType];

export interface AuthUser {
  id: number;
  username: string;
  fullName: string;
  email: string;
  role: UserRole;
  assignedLocationIds: number[];
  assignedFamilies: string[];
  isActive: boolean;
  lastLoginAt: string | null;
}

export interface LocationRecord {
  id: number;
  code: string;
  name: string;
  groupType: LocationGroup;
  address: string;
  managerUserId: number | null;
  managerName?: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface RiskWeights {
  rotation: number;
  currentStock: number;
  committedStock: number;
  movementCount: number;
  discrepancyHistory: number;
  priorCountDiffs: number;
  economicValue: number;
  daysSinceLastCount: number;
  adjustmentFrequency: number;
  commercialCriticality: number;
}

export interface RiskThresholds {
  critical: number;
  high: number;
  medium: number;
}

export interface ExcelColumnMapping {
  sku: string;
  description: string;
  alias?: string;
  family?: string;
  brand?: string;
  unitOfMeasure?: string;
  erpStock?: string;
  location?: string;
  costPrice?: string;
  committedStock?: string;
  criticality?: string;
}
