import {
  CriticalityLevel,
  RiskThresholds,
  RiskTier,
  RiskWeights,
  UserRole,
} from '../types/erp.ts';
import { db, DEFAULT_RISK_THRESHOLDS, DEFAULT_RISK_WEIGHTS } from './db.ts';

export interface RiskFactorBreakdown {
  variable: string;
  rawValue: string;
  normalizedScore: number;
  weight: number;
  weightedContribution: number;
}

export interface ProductLocationRisk {
  productId: number;
  sku: string;
  description: string;
  family: string;
  brand: string;
  unitOfMeasure: string;
  locationId: number;
  locationName: string;
  erpPhysicalStock: number;
  committedStock: number;
  availableStock: number;
  costPrice: number | null;
  economicValue: number;
  movementsCount: number;
  rotationQty: number;
  discrepancyCount: number;
  priorAdjustmentsCount: number;
  daysSinceLastCount: number;
  lastCountResult: string | null;
  lastCountDiff: number | null;
  criticalityLevel: CriticalityLevel;
  riskScore: number;
  riskTier: RiskTier;
  recommendedFrequencyDays: number;
  factors: RiskFactorBreakdown[];
}

export interface PlanningAlert {
  id: string;
  severity: 'CRITICA' | 'ALTA' | 'MEDIA';
  category:
    | 'CRITICO_SIN_CONTEO'
    | 'BAJA_COBERTURA'
    | 'DIFERENCIAS_REITERADAS'
    | 'MOVIMIENTOS_POST_CONTEO'
    | 'ALTA_ROTACION_SIN_CONTROL';
  locationId: number;
  locationName: string;
  productId?: number;
  sku?: string;
  title: string;
  detail: string;
}

export function getRiskConfig(): { weights: RiskWeights; thresholds: RiskThresholds } {
  const row = db
    .prepare('SELECT weights_json, thresholds_json FROM risk_config WHERE id = 1')
    .get() as { weights_json: string; thresholds_json: string } | undefined;

  if (!row) {
    return { weights: DEFAULT_RISK_WEIGHTS, thresholds: DEFAULT_RISK_THRESHOLDS };
  }
  try {
    return {
      weights: { ...DEFAULT_RISK_WEIGHTS, ...JSON.parse(row.weights_json) },
      thresholds: { ...DEFAULT_RISK_THRESHOLDS, ...JSON.parse(row.thresholds_json) },
    };
  } catch {
    return { weights: DEFAULT_RISK_WEIGHTS, thresholds: DEFAULT_RISK_THRESHOLDS };
  }
}

export function computeRiskMatrix(
  locationIdFilter?: number,
  familyFilter?: string
): ProductLocationRisk[] {
  const { weights, thresholds } = getRiskConfig();
  const totalWeight =
    Object.values(weights).reduce((acc, w) => acc + Math.max(0, Number(w)), 0) || 100;

  let rows: Array<Record<string, unknown>>;
  if (locationIdFilter) {
    const familyWhere = familyFilter ? 'WHERE p.family = ?' : '';
    const params: unknown[] = familyFilter
      ? [locationIdFilter, locationIdFilter, locationIdFilter, locationIdFilter, locationIdFilter, locationIdFilter, familyFilter]
      : [locationIdFilter, locationIdFilter, locationIdFilter, locationIdFilter, locationIdFilter, locationIdFilter];

    rows = db
      .prepare(
        `
        SELECT
          p.id as product_id,
          p.sku,
          p.description,
          p.family,
          p.brand,
          p.unit_of_measure,
          p.cost_price,
          p.criticality_level,
          l.id as location_id,
          l.name as location_name,
          COALESCE(ib.erp_physical_stock, 0) as erp_physical_stock,
          COALESCE(ib.committed_stock, 0) as committed_stock,
          COALESCE(ib.available_stock, 0) as available_stock,
          ib.last_counted_at,
          COALESCE((
            SELECT COUNT(*) FROM inventory_movements im
            WHERE im.product_id = p.id AND im.location_id = l.id
              AND im.movement_type != 'ERP_IMPORT'
          ), 0) as movements_count,
          COALESCE((
            SELECT SUM(ABS(im.quantity_delta)) FROM inventory_movements im
            WHERE im.product_id = p.id AND im.location_id = l.id
              AND im.movement_type IN ('POS_SALE', 'POS_RESERVE', 'POS_RETURN', 'ERP_ADJUSTMENT', 'ERP_MOVEMENT')
          ), 0) as rotation_qty,
          COALESCE((
            SELECT COUNT(*) FROM count_items ci
            JOIN counts c ON c.id = ci.count_id
            WHERE ci.product_id = p.id AND c.location_id = l.id
              AND ci.reconciliation_result IN ('FALTANTE', 'SOBRANTE')
          ), 0) as discrepancy_count,
          COALESCE((
            SELECT COUNT(*) FROM count_items ci
            JOIN counts c ON c.id = ci.count_id
            WHERE ci.product_id = p.id AND c.location_id = l.id
              AND ci.adjustment_status IN ('AJUSTE', 'MOVIMIENTO')
          ), 0) as prior_adjustments_count,
          (
            SELECT ci.reconciliation_result FROM count_items ci
            JOIN counts c ON c.id = ci.count_id
            WHERE ci.product_id = p.id AND c.location_id = l.id
              AND ci.reconciliation_result IS NOT NULL
            ORDER BY c.created_at DESC LIMIT 1
          ) as last_count_result,
          (
            SELECT ci.difference FROM count_items ci
            JOIN counts c ON c.id = ci.count_id
            WHERE ci.product_id = p.id AND c.location_id = l.id
              AND ci.difference IS NOT NULL
            ORDER BY c.created_at DESC LIMIT 1
          ) as last_count_diff
        FROM products p
        JOIN locations l ON l.id = ?
        LEFT JOIN inventory_balances ib ON ib.product_id = p.id AND ib.location_id = l.id
        ${familyWhere}
      `
      )
      .all(...params) as Array<Record<string, unknown>>;
  } else {
    const familyWhere = familyFilter ? 'WHERE p.family = ?' : '';
    const params: unknown[] = familyFilter ? [familyFilter] : [];
    rows = db
      .prepare(
        `
        SELECT
          p.id as product_id,
          p.sku,
          p.description,
          p.family,
          p.brand,
          p.unit_of_measure,
          p.cost_price,
          p.criticality_level,
          ib.location_id,
          l.name as location_name,
          ib.erp_physical_stock,
          ib.committed_stock,
          ib.available_stock,
          ib.last_counted_at,
          COALESCE((
            SELECT COUNT(*) FROM inventory_movements im
            WHERE im.product_id = p.id AND im.location_id = ib.location_id
              AND im.movement_type != 'ERP_IMPORT'
          ), 0) as movements_count,
          COALESCE((
            SELECT SUM(ABS(im.quantity_delta)) FROM inventory_movements im
            WHERE im.product_id = p.id AND im.location_id = ib.location_id
              AND im.movement_type IN ('POS_SALE', 'POS_RESERVE', 'POS_RETURN', 'ERP_ADJUSTMENT', 'ERP_MOVEMENT')
          ), 0) as rotation_qty,
          COALESCE((
            SELECT COUNT(*) FROM count_items ci
            JOIN counts c ON c.id = ci.count_id
            WHERE ci.product_id = p.id AND c.location_id = ib.location_id
              AND ci.reconciliation_result IN ('FALTANTE', 'SOBRANTE')
          ), 0) as discrepancy_count,
          COALESCE((
            SELECT COUNT(*) FROM count_items ci
            JOIN counts c ON c.id = ci.count_id
            WHERE ci.product_id = p.id AND c.location_id = ib.location_id
              AND ci.adjustment_status IN ('AJUSTE', 'MOVIMIENTO')
          ), 0) as prior_adjustments_count,
          (
            SELECT ci.reconciliation_result FROM count_items ci
            JOIN counts c ON c.id = ci.count_id
            WHERE ci.product_id = p.id AND c.location_id = ib.location_id
              AND ci.reconciliation_result IS NOT NULL
            ORDER BY c.created_at DESC LIMIT 1
          ) as last_count_result,
          (
            SELECT ci.difference FROM count_items ci
            JOIN counts c ON c.id = ci.count_id
            WHERE ci.product_id = p.id AND c.location_id = ib.location_id
              AND ci.difference IS NOT NULL
            ORDER BY c.created_at DESC LIMIT 1
          ) as last_count_diff
        FROM inventory_balances ib
        JOIN products p ON p.id = ib.product_id
        JOIN locations l ON l.id = ib.location_id
        ${familyWhere}
      `
      )
      .all(...params) as Array<Record<string, unknown>>;
  }

  const nowMs = Date.now();
  const maxEconomicValue =
    rows.reduce((max, r) => {
      const val = Math.max(0, Number(r.erp_physical_stock || 0)) * Math.max(0, Number(r.cost_price || 0));
      return Math.max(max, val);
    }, 0) || 1;

  const maxRotation =
    rows.reduce((max, r) => Math.max(max, Number(r.rotation_qty || 0)), 0) || 1;

  const maxMovements =
    rows.reduce((max, r) => Math.max(max, Number(r.movements_count || 0)), 0) || 1;

  const maxStock =
    rows.reduce((max, r) => Math.max(max, Math.abs(Number(r.erp_physical_stock || 0))), 0) || 1;

  return rows
    .map((r) => {
      const erpPhysicalStock = Number(r.erp_physical_stock || 0);
      const committedStock = Number(r.committed_stock || 0);
      const availableStock = Number(r.available_stock || 0);
      const costPrice = r.cost_price !== null && r.cost_price !== undefined ? Number(r.cost_price) : null;
      const economicValue = costPrice !== null ? Math.max(0, erpPhysicalStock) * costPrice : 0;
      const movementsCount = Number(r.movements_count || 0);
      const rotationQty = Number(r.rotation_qty || 0);
      const discrepancyCount = Number(r.discrepancy_count || 0);
      const priorAdjustmentsCount = Number(r.prior_adjustments_count || 0);
      const lastCountResult = r.last_count_result ? String(r.last_count_result) : null;
      const lastCountDiff =
        r.last_count_diff !== null && r.last_count_diff !== undefined ? Number(r.last_count_diff) : null;
      const criticalityLevel = (String(r.criticality_level || 'MEDIA') as CriticalityLevel);

      let daysSinceLastCount = 90;
      if (r.last_counted_at) {
        const lastMs = Date.parse(String(r.last_counted_at) + 'Z');
        if (!Number.isNaN(lastMs)) {
          daysSinceLastCount = Math.max(0, Math.floor((nowMs - lastMs) / (1000 * 60 * 60 * 24)));
        }
      }

      // Normalize each of the 10 variables to 0..100
      const normRotation = Math.min(100, (rotationQty / maxRotation) * 100);
      const normCurrentStock = Math.min(100, (Math.abs(erpPhysicalStock) / maxStock) * 100);
      const normCommitted =
        erpPhysicalStock > 0
          ? Math.min(100, (committedStock / erpPhysicalStock) * 100)
          : committedStock > 0
            ? 100
            : 0;
      const normMovementCount = Math.min(100, (movementsCount / maxMovements) * 100);
      const normDiscrepancyHistory = Math.min(100, discrepancyCount * 33.3);
      const normPriorDiffMagnitude =
        lastCountDiff !== null && erpPhysicalStock > 0
          ? Math.min(100, (Math.abs(lastCountDiff) / Math.max(1, erpPhysicalStock)) * 200)
          : lastCountDiff !== null && lastCountDiff !== 0
            ? 80
            : 0;
      const normEconomicValue = costPrice !== null ? Math.min(100, (economicValue / maxEconomicValue) * 100) : 0;
      const normDaysSinceCount = Math.min(100, (daysSinceLastCount / 60) * 100);
      const normAdjustmentFreq = Math.min(100, priorAdjustmentsCount * 35);
      const normCriticality =
        criticalityLevel === CriticalityLevel.ALTA
          ? 100
          : criticalityLevel === CriticalityLevel.MEDIA
            ? 55
            : 20;

      const factorList: Array<{ variable: string; rawValue: string; norm: number; weight: number }> = [
        {
          variable: '1. Rotación de mercadería',
          rawValue: `${rotationQty.toFixed(0)} un.`,
          norm: normRotation,
          weight: weights.rotation,
        },
        {
          variable: '2. Existencias actuales',
          rawValue: `${erpPhysicalStock} ${String(r.unit_of_measure || 'UN')}`,
          norm: normCurrentStock,
          weight: weights.currentStock,
        },
        {
          variable: '3. Stock comprometido',
          rawValue: `${committedStock} un.`,
          norm: normCommitted,
          weight: weights.committedStock,
        },
        {
          variable: '4. Cantidad de movimientos',
          rawValue: `${movementsCount} mov.`,
          norm: normMovementCount,
          weight: weights.movementCount,
        },
        {
          variable: '5. Historial faltantes/sobrantes',
          rawValue: `${discrepancyCount} eventos`,
          norm: normDiscrepancyHistory,
          weight: weights.discrepancyHistory,
        },
        {
          variable: '6. Diferencia último conteo',
          rawValue: lastCountDiff !== null ? `${lastCountDiff > 0 ? '+' : ''}${lastCountDiff}` : 'Sin conteo',
          norm: normPriorDiffMagnitude,
          weight: weights.priorCountDiffs,
        },
        {
          variable: '7. Valor económico en inventario',
          rawValue: costPrice !== null ? `$${economicValue.toLocaleString('es-AR', { maximumFractionDigits: 0 })}` : 'Sin costo',
          norm: normEconomicValue,
          weight: weights.economicValue,
        },
        {
          variable: '8. Antigüedad último conteo',
          rawValue: r.last_counted_at ? `${daysSinceLastCount} días` : 'Nunca contado',
          norm: normDaysSinceCount,
          weight: weights.daysSinceLastCount,
        },
        {
          variable: '9. Frecuencia de ajustes',
          rawValue: `${priorAdjustmentsCount} ajustes`,
          norm: normAdjustmentFreq,
          weight: weights.adjustmentFrequency,
        },
        {
          variable: '10. Criticidad comercial',
          rawValue: criticalityLevel,
          norm: normCriticality,
          weight: weights.commercialCriticality,
        },
      ];

      const factors: RiskFactorBreakdown[] = factorList.map((f) => ({
        variable: f.variable,
        rawValue: f.rawValue,
        normalizedScore: Math.round(f.norm * 10) / 10,
        weight: f.weight,
        weightedContribution: Math.round(((f.norm * f.weight) / totalWeight) * 10) / 10,
      }));

      const riskScore = Math.round(
        factors.reduce((sum, f) => sum + f.weightedContribution, 0) * 10
      ) / 10;

      let riskTier = RiskTier.BAJO;
      let recommendedFrequencyDays = 90;
      if (riskScore >= thresholds.critical) {
        riskTier = RiskTier.CRITICO;
        recommendedFrequencyDays = 7;
      } else if (riskScore >= thresholds.high) {
        riskTier = RiskTier.ALTO;
        recommendedFrequencyDays = 15;
      } else if (riskScore >= thresholds.medium) {
        riskTier = RiskTier.MEDIO;
        recommendedFrequencyDays = 30;
      }

      return {
        productId: Number(r.product_id),
        sku: String(r.sku),
        description: String(r.description),
        family: String(r.family || 'General'),
        brand: String(r.brand || 'Sin marca'),
        unitOfMeasure: String(r.unit_of_measure || 'UN'),
        locationId: Number(r.location_id),
        locationName: String(r.location_name),
        erpPhysicalStock,
        committedStock,
        availableStock,
        costPrice,
        economicValue,
        movementsCount,
        rotationQty,
        discrepancyCount,
        priorAdjustmentsCount,
        daysSinceLastCount,
        lastCountResult,
        lastCountDiff,
        criticalityLevel,
        riskScore,
        riskTier,
        recommendedFrequencyDays,
        factors,
      };
    })
    .sort((a, b) => b.riskScore - a.riskScore);
}

export function generatePlanningAlerts(): PlanningAlert[] {
  const alerts: PlanningAlert[] = [];
  const matrix = computeRiskMatrix();

  // 1. Critical items without recent count
  for (const item of matrix) {
    if (
      (item.riskTier === RiskTier.CRITICO || item.criticalityLevel === CriticalityLevel.ALTA) &&
      item.daysSinceLastCount >= 30
    ) {
      alerts.push({
        id: `crit-${item.locationId}-${item.productId}`,
        severity: 'CRITICA',
        category: 'CRITICO_SIN_CONTEO',
        locationId: item.locationId,
        locationName: item.locationName,
        productId: item.productId,
        sku: item.sku,
        title: `Artículo crítico sin conteo reciente (${item.sku})`,
        detail: `${item.description} en ${item.locationName}: riesgo ${item.riskTier} (${item.riskScore} pts), ${
          item.daysSinceLastCount >= 90 ? 'nunca contado' : `${item.daysSinceLastCount} días desde último conteo`
        }.`,
      });
    }

    // 2. Recurring discrepancies
    if (item.discrepancyCount >= 2) {
      alerts.push({
        id: `disc-${item.locationId}-${item.productId}`,
        severity: 'ALTA',
        category: 'DIFERENCIAS_REITERADAS',
        locationId: item.locationId,
        locationName: item.locationName,
        productId: item.productId,
        sku: item.sku,
        title: `Diferencias reiteradas en ${item.sku}`,
        detail: `${item.discrepancyCount} diferencias detectadas en conteos previos en ${item.locationName}. Último desvío: ${
          item.lastCountDiff !== null ? item.lastCountDiff : 'N/A'
        }.`,
      });
    }

    // 3. High rotation without recent control
    if (item.rotationQty > 0 && item.movementsCount >= 3 && item.daysSinceLastCount >= 15) {
      alerts.push({
        id: `rot-${item.locationId}-${item.productId}`,
        severity: 'MEDIA',
        category: 'ALTA_ROTACION_SIN_CONTROL',
        locationId: item.locationId,
        locationName: item.locationName,
        productId: item.productId,
        sku: item.sku,
        title: `Alta rotación sin control reciente (${item.sku})`,
        detail: `${item.movementsCount} movimientos registrados (${item.rotationQty} un.) sin conteo reciente en ${item.locationName}.`,
      });
    }
  }

  // 4. Low coverage by location
  const coverageRows = db
    .prepare(
      `
      SELECT l.id, l.name,
        COUNT(ib.id) as total_items,
        SUM(CASE WHEN ib.last_counted_at IS NOT NULL THEN 1 ELSE 0 END) as counted_items
      FROM locations l
      LEFT JOIN inventory_balances ib ON ib.location_id = l.id
      WHERE l.is_active = 1
      GROUP BY l.id
    `
    )
    .all() as Array<{ id: number; name: string; total_items: number; counted_items: number }>;

  for (const loc of coverageRows) {
    if (loc.total_items > 0) {
      const pct = (loc.counted_items / loc.total_items) * 100;
      if (pct < 40) {
        alerts.push({
          id: `cov-${loc.id}`,
          severity: 'ALTA',
          category: 'BAJA_COBERTURA',
          locationId: loc.id,
          locationName: loc.name,
          title: `Baja cobertura de conteos en ${loc.name}`,
          detail: `Solo ${loc.counted_items} de ${loc.total_items} artículos (${pct.toFixed(
            0
          )}%) cuentan con relevamiento físico registrado.`,
        });
      }
    }
  }

  // 5. Significant movements after last count
  const postMovRows = db
    .prepare(
      `
      SELECT ib.product_id, p.sku, p.description, ib.location_id, l.name as location_name,
        ib.last_counted_at, COUNT(im.id) as post_mov_cnt, SUM(ABS(im.quantity_delta)) as post_mov_qty
      FROM inventory_balances ib
      JOIN products p ON p.id = ib.product_id
      JOIN locations l ON l.id = ib.location_id
      JOIN inventory_movements im ON im.product_id = ib.product_id AND im.location_id = ib.location_id
      WHERE ib.last_counted_at IS NOT NULL
        AND im.created_at > ib.last_counted_at
        AND im.movement_type != 'ERP_IMPORT'
      GROUP BY ib.product_id, ib.location_id
      HAVING post_mov_cnt >= 2
    `
    )
    .all() as Array<{
      product_id: number;
      sku: string;
      description: string;
      location_id: number;
      location_name: string;
      post_mov_cnt: number;
      post_mov_qty: number;
    }>;

  for (const pm of postMovRows) {
    alerts.push({
      id: `post-${pm.location_id}-${pm.product_id}`,
      severity: 'MEDIA',
      category: 'MOVIMIENTOS_POST_CONTEO',
      locationId: pm.location_id,
      locationName: pm.location_name,
      productId: pm.product_id,
      sku: pm.sku,
      title: `Movimientos significativos posteriores al último conteo (${pm.sku})`,
      detail: `${pm.post_mov_cnt} movimientos (${pm.post_mov_qty} un.) en ${pm.location_name} después del último conteo.`,
    });
  }

  return alerts.slice(0, 60);
}

export function buildHistoricalAlertForItem(productId: number, locationId: number): string {
  const pastDiscrepancies = db
    .prepare(
      `
      SELECT c.count_number, c.created_at, ci.reconciliation_result, ci.difference, ci.adjustment_status
      FROM count_items ci
      JOIN counts c ON c.id = ci.count_id
      WHERE ci.product_id = ? AND c.location_id = ?
        AND ci.reconciliation_result IN ('FALTANTE', 'SOBRANTE')
      ORDER BY c.created_at DESC
    `
    )
    .all(productId, locationId) as Array<{
      count_number: string;
      created_at: string;
      reconciliation_result: string;
      difference: number;
      adjustment_status: string;
    }>;

  if (pastDiscrepancies.length === 0) {
    return '';
  }

  const latest = pastDiscrepancies[0];
  const faltantes = pastDiscrepancies.filter((d) => d.reconciliation_result === 'FALTANTE').length;
  const sobrantes = pastDiscrepancies.filter((d) => d.reconciliation_result === 'SOBRANTE').length;
  const ajustes = pastDiscrepancies.filter(
    (d) => d.adjustment_status === 'AJUSTE' || d.adjustment_status === 'MOVIMIENTO'
  ).length;

  const tipoUltimo = latest.difference < 0 ? `faltante de ${Math.abs(latest.difference)}` : `sobrante de ${latest.difference}`;
  return `ARTÍCULO CON ANTECEDENTES: Se detectaron diferencias en ${pastDiscrepancies.length} conteo(s) anterior(es) (${faltantes} faltante(s), ${sobrantes} sobrante(s), ${ajustes} ajuste(s)). Último resultado (${latest.count_number}): ${tipoUltimo} unidades. Se recomienda revisión prioritaria.`;
}

export function suggestBalancedDistribution(params: {
  locationId: number;
  maxItems: number;
  family?: string;
  counterIds?: number[];
}): {
  counters: Array<{
    counterId: number;
    counterName: string;
    assignedFamilies: string[];
    currentPendingItems: number;
    assignedItems: ProductLocationRisk[];
  }>;
  totalSelected: number;
} {
  let counters = db
    .prepare(
      `
      SELECT u.id, u.full_name, u.assigned_location_ids, u.assigned_families,
        COALESCE((
          SELECT COUNT(ci.id)
          FROM counts c
          JOIN count_items ci ON ci.count_id = c.id
          WHERE c.assigned_counter_id = u.id
            AND c.status IN ('PROGRAMADO', 'EN_PROGRESO', 'RECONTEO_SOLICITADO')
        ), 0) as current_pending_items
      FROM users u
      WHERE u.role = ? AND u.is_active = 1
      ORDER BY current_pending_items ASC, u.id ASC
    `
    )
    .all(UserRole.CONTADOR) as Array<{
      id: number;
      full_name: string;
      assigned_location_ids: string;
      assigned_families: string;
      current_pending_items: number;
    }>;

  if (params.counterIds && params.counterIds.length > 0) {
    const idSet = new Set(params.counterIds);
    counters = counters.filter((c) => idSet.has(c.id));
  }

  const parsedCounters = counters.map((c) => {
    let locIds: number[] = [];
    let famList: string[] = [];
    try {
      locIds = JSON.parse(c.assigned_location_ids || '[]').map(Number);
    } catch {
      locIds = [];
    }
    try {
      famList = JSON.parse(c.assigned_families || '[]')
        .map((f: unknown) => String(f).trim())
        .filter(Boolean);
    } catch {
      famList = [];
    }
    return {
      ...c,
      locIds,
      famList,
    };
  });

  // Prefer counters assigned to this location (or unrestricted)
  const locationMatched = parsedCounters.filter(
    (c) => c.locIds.length === 0 || c.locIds.includes(params.locationId)
  );
  const activePool = locationMatched.length > 0 ? locationMatched : parsedCounters;

  if (activePool.length === 0) {
    return { counters: [], totalSelected: 0 };
  }

  const rankedItems = computeRiskMatrix(params.locationId, params.family).slice(
    0,
    Math.max(1, params.maxItems)
  );

  // Greedy load-balanced assignment respecting counter's assigned families when configured
  const buckets = activePool.map((c) => ({
    counterId: c.id,
    counterName: c.full_name,
    assignedFamilies: c.famList,
    currentPendingItems: c.current_pending_items,
    projectedTotal: c.current_pending_items,
    assignedItems: [] as ProductLocationRisk[],
  }));

  for (const item of rankedItems) {
    const familyMatching = buckets.filter(
      (b) =>
        b.assignedFamilies.length === 0 ||
        b.assignedFamilies.some((f) => f.toLowerCase() === item.family.toLowerCase())
    );
    const candidateBuckets = familyMatching.length > 0 ? familyMatching : buckets;
    candidateBuckets.sort((a, b) => a.projectedTotal - b.projectedTotal);
    candidateBuckets[0].assignedItems.push(item);
    candidateBuckets[0].projectedTotal += 1;
  }

  return {
    counters: buckets.map((b) => ({
      counterId: b.counterId,
      counterName: b.counterName,
      assignedFamilies: b.assignedFamilies,
      currentPendingItems: b.currentPendingItems,
      assignedItems: b.assignedItems,
    })),
    totalSelected: rankedItems.length,
  };
}
