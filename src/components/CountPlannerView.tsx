import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Info,
  SlidersHorizontal,
  Target,
  Users,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { AuthUser, RiskThresholds, RiskTier, RiskWeights, UserRole } from '../types/erp';

interface RiskItem {
  productId: number;
  sku: string;
  description: string;
  family: string;
  locationId: number;
  locationName: string;
  erpPhysicalStock: number;
  committedStock: number;
  costPrice: number | null;
  economicValue: number;
  movementsCount: number;
  discrepancyCount: number;
  daysSinceLastCount: number;
  riskScore: number;
  riskTier: RiskTier;
  recommendedFrequencyDays: number;
  factors: Array<{
    variable: string;
    rawValue: string;
    normalizedScore: number;
    weight: number;
    weightedContribution: number;
  }>;
}

interface PlanningAlert {
  id: string;
  severity: 'CRITICA' | 'ALTA' | 'MEDIA';
  locationName: string;
  title: string;
  detail: string;
}

export const CountPlannerView: React.FC = () => {
  const [locations, setLocations] = useState<Array<{ id: number; name: string }>>([]);
  const [families, setFamilies] = useState<string[]>([]);
  const [counters, setCounters] = useState<AuthUser[]>([]);
  const [selectedLocId, setSelectedLocId] = useState<string>('');
  const [selectedFamily, setSelectedFamily] = useState<string>('');
  const [scheduledDate, setScheduledDate] = useState(new Date().toISOString().slice(0, 10));
  const [maxItems, setMaxItems] = useState(15);
  const [weeklyGoalTag, setWeeklyGoalTag] = useState('');

  const [matrix, setMatrix] = useState<RiskItem[]>([]);
  const [alerts, setAlerts] = useState<PlanningAlert[]>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<number[]>([]);
  const [manualCounterId, setManualCounterId] = useState<string>('');

  const [distributionPlan, setDistributionPlan] = useState<{
    counters: Array<{
      counterId: number;
      counterName: string;
      assignedFamilies?: string[];
      currentPendingItems: number;
      assignedItems: RiskItem[];
    }>;
    totalSelected: number;
  } | null>(null);

  const [showConfig, setShowConfig] = useState(false);
  const [weights, setWeights] = useState<RiskWeights | null>(null);
  const [thresholds, setThresholds] = useState<RiskThresholds | null>(null);
  const [inspectItem, setInspectItem] = useState<RiskItem | null>(null);

  const [goals, setGoals] = useState<Array<Record<string, unknown>>>([]);
  const [goalForm, setGoalForm] = useState({
    periodType: 'SEMANAL',
    targetDate: new Date().toISOString().slice(0, 10),
    assignedCounterId: '',
    targetItemsCount: 50,
  });

  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [locRes, userRes, cfgRes, goalsRes, famRes] = await Promise.all([
        apiFetch<{ locations: Array<{ id: number; name: string }> }>('/api/locations'),
        apiFetch<{ users: AuthUser[] }>('/api/users'),
        apiFetch<{ weights: RiskWeights; thresholds: RiskThresholds }>('/api/risk/config'),
        apiFetch<{ goals: Array<Record<string, unknown>> }>('/api/goals'),
        apiFetch<{ families: string[] }>('/api/products/families'),
      ]);

      setLocations(locRes.locations);
      setFamilies(famRes.families);
      const activeCounters = userRes.users.filter((u) => u.role === UserRole.CONTADOR && u.isActive);
      setCounters(activeCounters);
      if (!manualCounterId && activeCounters[0]) setManualCounterId(String(activeCounters[0].id));
      if (!selectedLocId && locRes.locations[0]) setSelectedLocId(String(locRes.locations[0].id));

      setWeights(cfgRes.weights);
      setThresholds(cfgRes.thresholds);
      setGoals(goalsRes.goals);

      const qsParams = new URLSearchParams();
      if (selectedLocId) qsParams.set('locationId', selectedLocId);
      if (selectedFamily) qsParams.set('family', selectedFamily);
      const qs = qsParams.toString() ? `?${qsParams.toString()}` : '';
      const riskRes = await apiFetch<{ matrix: RiskItem[]; alerts: PlanningAlert[] }>(
        `/api/risk/matrix${qs}`
      );
      setMatrix(riskRes.matrix);
      setAlerts(riskRes.alerts);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, [selectedLocId, selectedFamily]);

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!weights || !thresholds) return;
    try {
      await apiFetch('/api/risk/config', {
        method: 'PUT',
        body: JSON.stringify({ weights, thresholds }),
      });
      setShowConfig(false);
      setMessage('Parámetros del algoritmo de puntuación de riesgo actualizados.');
      await loadAll();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const handleCalculateDistribution = async () => {
    setError(null);
    setMessage(null);
    if (!selectedLocId) {
      setError('Seleccione una ubicación para calcular la distribución.');
      return;
    }
    try {
      const res = await apiFetch<NonNullable<typeof distributionPlan>>('/api/risk/distribute', {
        method: 'POST',
        body: JSON.stringify({
          locationId: Number(selectedLocId),
          maxItems,
          family: selectedFamily || undefined,
        }),
      });
      setDistributionPlan(res);
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const handleApproveBatchDistribution = async () => {
    if (!distributionPlan || !selectedLocId) return;
    setError(null);
    try {
      const assignments = distributionPlan.counters
        .filter((c) => c.assignedItems.length > 0)
        .map((c) => ({
          counterId: c.counterId,
          productIds: c.assignedItems.map((i) => i.productId),
        }));

      const res = await apiFetch<{ createdCounts: Array<{ countNumber: string }> }>(
        '/api/counts/batch-plan',
        {
          method: 'POST',
          body: JSON.stringify({
            locationId: Number(selectedLocId),
            scheduledDate,
            weeklyGoalTag,
            assignments,
          }),
        }
      );

      setDistributionPlan(null);
      setMessage(
        `Programación aprobada: se generaron ${res.createdCounts.length} conteo(s) ciego(s) (${res.createdCounts
          .map((c) => c.countNumber)
          .join(', ')}).`
      );
      await loadAll();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const handleCreateManualCount = async (saveAsDraft = false) => {
    setError(null);
    if (!selectedLocId || selectedProductIds.length === 0) {
      setError('Seleccione ubicación y al menos un artículo.');
      return;
    }
    if (!saveAsDraft && !manualCounterId) {
      setError('Seleccione un responsable de conteo o elija Crear sin Asignar.');
      return;
    }
    try {
      const res = await apiFetch<{ countNumber: string; status: string }>('/api/counts', {
        method: 'POST',
        body: JSON.stringify({
          locationId: Number(selectedLocId),
          scheduledDate,
          assignedCounterId: saveAsDraft ? null : Number(manualCounterId),
          productIds: selectedProductIds,
          weeklyGoalTag,
          saveAsDraft,
        }),
      });
      setSelectedProductIds([]);
      setMessage(
        saveAsDraft
          ? `Conteo ${res.countNumber} creado en estado EJECUCIÓN (pendiente de asignación).`
          : `Conteo ciego ${res.countNumber} creado en EJECUCIÓN y asignado correctamente.`
      );
      await loadAll();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const handleCreateGoal = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/goals', {
        method: 'POST',
        body: JSON.stringify({
          periodType: goalForm.periodType,
          targetDate: goalForm.targetDate,
          locationId: selectedLocId ? Number(selectedLocId) : null,
          assignedCounterId: goalForm.assignedCounterId ? Number(goalForm.assignedCounterId) : null,
          targetItemsCount: goalForm.targetItemsCount,
        }),
      });
      setMessage('Meta operativa registrada.');
      await loadAll();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const riskBadgeText = (tier: RiskTier) => {
    switch (tier) {
      case RiskTier.CRITICO:
        return <span className="font-semibold text-red-700">Crítico</span>;
      case RiskTier.ALTO:
        return <span className="font-semibold text-amber-700">Alto</span>;
      case RiskTier.MEDIO:
        return <span className="font-semibold text-blue-700">Medio</span>;
      default:
        return <span className="text-slate-600">Bajo</span>;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Planificación Inteligente de Conteos</h2>
          <p className="text-sm text-slate-600 mt-0.5">
            Priorización por matriz multifactorial de 10 variables y distribución equitativa entre los responsables de conteo.
          </p>
        </div>
        <button
          onClick={() => setShowConfig(!showConfig)}
          className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          Configurar Algoritmo de Riesgo
        </button>
      </div>

      {message && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          {message}
        </div>
      )}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
          {error}
        </div>
      )}

      {counters.length === 0 && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>
            No hay usuarios con rol <strong>Responsable de Conteo</strong> activos. Cree hasta 3 contadores en el módulo Usuarios y Permisos para habilitar la distribución de tareas.
          </span>
        </div>
      )}

      {showConfig && weights && thresholds && (
        <form onSubmit={handleSaveConfig} className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-bold text-slate-900">
            Configuración de Ponderación de las 10 Variables de Riesgo
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
            {(
              [
                ['rotation', '1. Rotación'],
                ['currentStock', '2. Existencia Actual'],
                ['committedStock', '3. Comprometido'],
                ['movementCount', '4. Nro Movimientos'],
                ['discrepancyHistory', '5. Hist. Diferencias'],
                ['priorCountDiffs', '6. Magnitud Desvío'],
                ['economicValue', '7. Valor Económico'],
                ['daysSinceLastCount', '8. Antigüedad Conteo'],
                ['adjustmentFrequency', '9. Frec. Ajustes'],
                ['commercialCriticality', '10. Criticidad'],
              ] as Array<[keyof RiskWeights, string]>
            ).map(([k, label]) => (
              <div key={k}>
                <label className="block text-slate-600 mb-1">{label}</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={weights[k]}
                  onChange={(e) => setWeights({ ...weights, [k]: Number(e.target.value) })}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded font-mono"
                />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-3 text-xs pt-2 border-t border-slate-100">
            <div>
              <label className="block text-slate-600 mb-1">Umbral Riesgo Crítico (&ge;)</label>
              <input
                type="number"
                value={thresholds.critical}
                onChange={(e) => setThresholds({ ...thresholds, critical: Number(e.target.value) })}
                className="w-full px-2.5 py-1.5 border border-slate-300 rounded font-mono"
              />
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Umbral Riesgo Alto (&ge;)</label>
              <input
                type="number"
                value={thresholds.high}
                onChange={(e) => setThresholds({ ...thresholds, high: Number(e.target.value) })}
                className="w-full px-2.5 py-1.5 border border-slate-300 rounded font-mono"
              />
            </div>
            <div>
              <label className="block text-slate-600 mb-1">Umbral Riesgo Medio (&ge;)</label>
              <input
                type="number"
                value={thresholds.medium}
                onChange={(e) => setThresholds({ ...thresholds, medium: Number(e.target.value) })}
                className="w-full px-2.5 py-1.5 border border-slate-300 rounded font-mono"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowConfig(false)}
              className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
            >
              Cerrar
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-lg"
            >
              Guardar Algoritmo
            </button>
          </div>
        </form>
      )}

      {/* Alerts + Planner Controls */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <Calendar className="w-4 h-4 text-[#8e0d0d]" />
            <span>Generador y Distribuidor de Conteos Ciegos</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3 text-xs">
            <div>
              <label className="block font-medium text-slate-700 mb-1">Depósito / Ubicación</label>
              <select
                value={selectedLocId}
                onChange={(e) => setSelectedLocId(e.target.value)}
                className="w-full px-2.5 py-2 border border-slate-300 rounded-lg bg-white"
              >
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Familia de Conteo</label>
              <select
                value={selectedFamily}
                onChange={(e) => setSelectedFamily(e.target.value)}
                className="w-full px-2.5 py-2 border border-slate-300 rounded-lg bg-white"
              >
                <option value="">Todas las familias</option>
                {families.map((fam) => (
                  <option key={fam} value={fam}>
                    {fam}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Fecha Programada</label>
              <input
                type="date"
                value={scheduledDate}
                onChange={(e) => setScheduledDate(e.target.value)}
                className="w-full px-2.5 py-2 border border-slate-300 rounded-lg font-mono"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Artículos a Contar</label>
              <input
                type="number"
                min={1}
                max={200}
                value={maxItems}
                onChange={(e) => setMaxItems(Number(e.target.value))}
                className="w-full px-2.5 py-2 border border-slate-300 rounded-lg font-mono"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Etiqueta Meta / Semana</label>
              <input
                type="text"
                value={weeklyGoalTag}
                onChange={(e) => setWeeklyGoalTag(e.target.value)}
                placeholder="Ej. Sem-47 Prioridad"
                className="w-full px-2.5 py-2 border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
            <button
              onClick={handleCalculateDistribution}
              disabled={counters.length === 0 || matrix.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50"
            >
              <Users className="w-3.5 h-3.5" />
              Proponer Distribución Inteligente ({counters.length} contadores)
            </button>

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={manualCounterId}
                onChange={(e) => setManualCounterId(e.target.value)}
                className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white max-w-xs"
              >
                {counters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.fullName}
                    {c.assignedFamilies && c.assignedFamilies.length > 0
                      ? ` (${c.assignedFamilies.join(', ')})`
                      : ''}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => handleCreateManualCount(false)}
                disabled={selectedProductIds.length === 0 || !manualCounterId}
                className="px-3 py-1.5 text-xs font-medium border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 disabled:opacity-50"
              >
                Asignar Selección Manual ({selectedProductIds.length})
              </button>
              <button
                type="button"
                onClick={() => handleCreateManualCount(true)}
                disabled={selectedProductIds.length === 0}
                className="px-3 py-1.5 text-xs font-medium border border-slate-300 text-slate-700 bg-slate-50 rounded-lg hover:bg-slate-100 disabled:opacity-50"
              >
                Crear sin Asignar ({selectedProductIds.length})
              </button>
            </div>
          </div>

          {distributionPlan && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-900">
                  Propuesta Balanceada ({distributionPlan.totalSelected} artículos priorizados por riesgo)
                </span>
                <button
                  onClick={handleApproveBatchDistribution}
                  className="px-3 py-1.5 text-xs font-medium bg-[#8e0d0d] text-white rounded-lg hover:bg-[#6e0909]"
                >
                  Aprobar y Generar Conteos
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {distributionPlan.counters.map((c) => (
                  <div key={c.counterId} className="bg-white border border-slate-200 rounded-lg p-3 text-xs">
                    <div className="font-semibold text-slate-900">{c.counterName}</div>
                    {c.assignedFamilies && c.assignedFamilies.length > 0 && (
                      <div className="text-[11px] text-[#8e0d0d] mt-0.5">
                        Familias: {c.assignedFamilies.join(', ')}
                      </div>
                    )}
                    <div className="text-slate-500 mt-0.5">
                      Carga previa: {c.currentPendingItems} · Asignados ahora: {c.assignedItems.length}
                    </div>
                    <ul className="mt-2 space-y-1 max-h-28 overflow-y-auto text-[11px] text-slate-700">
                      {c.assignedItems.map((it) => (
                        <li key={it.productId} className="truncate font-mono">
                          {it.sku} · {it.family} ({it.riskScore} pts)
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Planning Alerts Panel */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-900 mb-3">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            <span>Alertas de Planificación ({alerts.length})</span>
          </div>
          {alerts.length === 0 ? (
            <p className="text-xs text-slate-500">
              {matrix.length === 0
                ? 'Importe el Excel del ERP en el Almacén Maestro para activar el análisis de alertas.'
                : 'Sin alertas críticas pendientes.'}
            </p>
          ) : (
            <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
              {alerts.map((al) => (
                <div key={al.id} className="p-2.5 border border-slate-200 rounded-lg text-xs">
                  <div className="flex items-center justify-between gap-2 font-semibold">
                    <span
                      className={
                        al.severity === 'CRITICA'
                          ? 'text-red-700'
                          : al.severity === 'ALTA'
                            ? 'text-amber-700'
                            : 'text-blue-700'
                      }
                    >
                      {al.severity} · {al.locationName}
                    </span>
                  </div>
                  <div className="font-medium text-slate-900 mt-0.5">{al.title}</div>
                  <div className="text-slate-600 mt-0.5 text-[11px]">{al.detail}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Risk Matrix Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-900">
            Matriz de Riesgo por Artículo en Ubicación Seleccionada ({matrix.length})
          </h3>
          <span className="text-xs text-slate-500">
            Ordenado de mayor a menor puntuación de riesgo
          </span>
        </div>
        {loading ? (
          <div className="p-8 text-center text-xs text-slate-500">Calculando matriz de riesgo...</div>
        ) : matrix.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-500">
            No hay existencias registradas para esta ubicación. Importe primero el archivo Excel del ERP.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
                  <th className="py-2.5 px-3 w-8">Sel.</th>
                  <th className="py-2.5 px-3">Código</th>
                  <th className="py-2.5 px-3">Descripción</th>
                  <th className="py-2.5 px-3">Familia</th>
                  <th className="py-2.5 px-3">Prioridad</th>
                  <th className="py-2.5 px-3 text-right">Puntaje</th>
                  <th className="py-2.5 px-3 text-right">Frec. Sug.</th>
                  <th className="py-2.5 px-3 text-right">Stock ERP</th>
                  <th className="py-2.5 px-3 text-right">Valor Inv.</th>
                  <th className="py-2.5 px-3 text-right">Mov.</th>
                  <th className="py-2.5 px-3 text-right">Dif. Prev.</th>
                  <th className="py-2.5 px-3 text-right">Días s/Conteo</th>
                  <th className="py-2.5 px-3">Explicación</th>
                </tr>
              </thead>
              <tbody>
                {matrix.slice(0, 150).map((item) => {
                  const checked = selectedProductIds.includes(item.productId);
                  return (
                    <tr
                      key={`${item.locationId}-${item.productId}`}
                      className="border-b border-slate-100 hover:bg-slate-50"
                    >
                      <td className="py-2 px-3">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedProductIds([...selectedProductIds, item.productId]);
                            } else {
                              setSelectedProductIds(
                                selectedProductIds.filter((id) => id !== item.productId)
                              );
                            }
                          }}
                        />
                      </td>
                      <td className="py-2 px-3 font-mono font-semibold text-slate-900">{item.sku}</td>
                      <td className="py-2 px-3 text-slate-800">{item.description}</td>
                      <td className="py-2 px-3 text-slate-600">{item.family}</td>
                      <td className="py-2 px-3">{riskBadgeText(item.riskTier)}</td>
                      <td className="py-2 px-3 text-right font-mono font-bold tabular-nums">
                        {item.riskScore}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-600">
                        c/ {item.recommendedFrequencyDays}d
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">
                        {item.erpPhysicalStock}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">
                        {item.costPrice !== null
                          ? `$${item.economicValue.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`
                          : '—'}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">
                        {item.movementsCount}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">
                        {item.discrepancyCount}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">
                        {item.daysSinceLastCount >= 90 ? 'Nunca' : `${item.daysSinceLastCount}d`}
                      </td>
                      <td className="py-2 px-3">
                        <button
                          onClick={() => setInspectItem(item)}
                          className="inline-flex items-center gap-1 text-blue-700 hover:underline"
                        >
                          <Info className="w-3.5 h-3.5" />
                          Ver factores
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Daily / Weekly Goals */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <Target className="w-4 h-4 text-[#8e0d0d]" />
          <span>Metas Diarias y Semanales de Conteo</span>
        </div>
        <form onSubmit={handleCreateGoal} className="flex flex-wrap items-end gap-3 text-xs">
          <div>
            <label className="block text-slate-600 mb-1">Período</label>
            <select
              value={goalForm.periodType}
              onChange={(e) => setGoalForm({ ...goalForm, periodType: e.target.value })}
              className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
            >
              <option value="DIARIA">Diaria</option>
              <option value="SEMANAL">Semanal</option>
            </select>
          </div>
          <div>
            <label className="block text-slate-600 mb-1">Fecha Objetivo</label>
            <input
              type="date"
              value={goalForm.targetDate}
              onChange={(e) => setGoalForm({ ...goalForm, targetDate: e.target.value })}
              className="px-2.5 py-1.5 border border-slate-300 rounded-lg font-mono"
            />
          </div>
          <div>
            <label className="block text-slate-600 mb-1">Contador (opcional)</label>
            <select
              value={goalForm.assignedCounterId}
              onChange={(e) => setGoalForm({ ...goalForm, assignedCounterId: e.target.value })}
              className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
            >
              <option value="">Todo el equipo</option>
              {counters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.fullName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-slate-600 mb-1">Meta (Artículos)</label>
            <input
              type="number"
              min={1}
              value={goalForm.targetItemsCount}
              onChange={(e) => setGoalForm({ ...goalForm, targetItemsCount: Number(e.target.value) })}
              className="w-28 px-2.5 py-1.5 border border-slate-300 rounded-lg font-mono"
            />
          </div>
          <button
            type="submit"
            className="px-3 py-1.5 bg-slate-900 text-white rounded-lg font-medium hover:bg-slate-800"
          >
            Fijar Meta
          </button>
        </form>

        {goals.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs pt-2">
            {goals.slice(0, 6).map((g) => (
              <div key={String(g.id)} className="p-3 border border-slate-200 rounded-lg">
                <div className="font-mono text-[11px] text-slate-500">
                  {String(g.period_type)} · {String(g.target_date)}
                </div>
                <div className="font-semibold text-slate-900 mt-0.5">
                  Objetivo: {Number(g.target_items_count)} artículos
                </div>
                <div className="text-slate-600 text-[11px]">
                  {g.counter_name ? String(g.counter_name) : 'Equipo completo'} ·{' '}
                  {g.location_name ? String(g.location_name) : 'Todas las ubicaciones'}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Factor Breakdown Modal */}
      {inspectItem && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-2xl p-6 space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-xs font-mono text-slate-500">
                  {inspectItem.sku} · {inspectItem.locationName}
                </div>
                <h3 className="text-base font-bold text-slate-900">{inspectItem.description}</h3>
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-500">Puntaje Total</div>
                <div className="text-xl font-mono font-bold text-slate-900">
                  {inspectItem.riskScore} / 100
                </div>
              </div>
            </div>

            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="py-2">Variable Analizada</th>
                  <th className="py-2">Dato Medido</th>
                  <th className="py-2 text-right">Norm. (0-100)</th>
                  <th className="py-2 text-right">Peso</th>
                  <th className="py-2 text-right">Aporte</th>
                </tr>
              </thead>
              <tbody>
                {inspectItem.factors.map((f) => (
                  <tr key={f.variable} className="border-b border-slate-100">
                    <td className="py-1.5 font-medium text-slate-800">{f.variable}</td>
                    <td className="py-1.5 font-mono text-slate-600">{f.rawValue}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums">{f.normalizedScore}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums">{f.weight}%</td>
                    <td className="py-1.5 text-right font-mono font-semibold tabular-nums">
                      +{f.weightedContribution}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="flex justify-end">
              <button
                onClick={() => setInspectItem(null)}
                className="px-4 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
