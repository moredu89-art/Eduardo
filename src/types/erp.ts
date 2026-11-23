export enum UserRole {
  JEFE_STOCK = 'JEFE_STOCK',
  CONTADOR = 'CONTADOR',
  RESPONSABLE_DEPOSITO = 'RESPONSABLE_DEPOSITO',
}

export enum LocationGroup {
  CASA_CENTRAL = 'CASA_CENTRAL',
  SUCURSAL = 'SUCURSAL',
}

export enum CriticalityLevel {
  ALTA = 'ALTA',
  MEDIA = 'MEDIA',
  BAJA = 'BAJA',
}

export enum RiskTier {
  CRITICO = 'CRITICO',
  ALTO = 'ALTO',
  MEDIO = 'MEDIO',
  BAJO = 'BAJO',
}

export enum CountStatus {
  PROGRAMADO = 'PROGRAMADO',
  EN_PROGRESO = 'EN_PROGRESO',
  ENVIADO_REVISION = 'ENVIADO_REVISION',
  RECONTEO_SOLICITADO = 'RECONTEO_SOLICITADO',
  VALIDADO = 'VALIDADO',
  CERRADO = 'CERRADO',
}

export enum ReconciliationResult {
  COINCIDENCIA = 'COINCIDENCIA',
  FALTANTE = 'FALTANTE',
  SOBRANTE = 'SOBRANTE',
}

export enum AdjustmentOperationType {
  PENDIENTE = 'PENDIENTE',
  AJUSTE = 'AJUSTE',
  MOVIMIENTO = 'MOVIMIENTO',
  SIN_AJUSTE = 'SIN_AJUSTE',
}

export enum PosOperationType {
  VENTA = 'VENTA',
  RESERVA = 'RESERVA',
  DEVOLUCION = 'DEVOLUCION',
}

export enum PosOperationStatus {
  PENDIENTE = 'PENDIENTE',
  CONFIRMADA = 'CONFIRMADA',
  ANULADA = 'ANULADA',
}

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
  salePrice?: string;
  committedStock?: string;
  criticality?: string;
}
