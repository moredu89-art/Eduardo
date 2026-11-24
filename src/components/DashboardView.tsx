import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  Download,
  Eye,
  Filter,
  Palette,
  RotateCcw,
  TrendingUp,
  Users,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { getCountStatusMeta } from '../lib/countStatus';
import { exportExecutiveSummaryPdf } from '../lib/pdfExport';
import { AuthUser, CountStatus, LocationGroup, UserRole } from '../types/erp';

interface QuickMetrics {
  activeInventoryCounts: number;
  enEjecucion: number;
  entregados: number;
  rechazados: number;
  aprobados: number;
  aprobadosPendientesReg: number;
  aprobadosRegularizados: number;
  activeStockUnits: number;
  monthlyApprovedCounts?: number;
}

interface WorkflowSummary {
  totalCreated: number;
  enEjecucion: number;
  entregados: number;
  rechazados: number;
  aprobados: number;
  aprobadosPendientesReg: number;
  aprobadosRegularizados: number;
  overdueCounts: number;
}

interface TrackingAlert {
  key: string;
  severity: 'CRITICA' | 'ALTA' | 'MEDIA';
  title: string;
  count: number;
  targetTab: 'management' | 'validation' | 'counts';
  filterStatus?: string;
}

interface ActiveCounterCountItem {
  id: number;
  count_number: string;
  location_name: string;
  location_group: LocationGroup | string;
  scheduled_date: string;
  status: CountStatus;
  items_count: number;
  counted_items_count: number;
  is_overdue: boolean;
}

interface ActiveCountsByCounter {
  counterId: number | null;
  counterName: string;
  counterUsername: string;
  role: string;
  assignedLocationsLabel: string;
  totalActive: number;
  inExecutionCount: number;
  deliveredCount: number;
  rejectedCount: number;
  overdueCount: number;
  counts: ActiveCounterCountItem[];
}

interface MonthlyPendingCountRow {
  id: number;
  count_number: string;
  location_id: number;
  location_name: string;
  location_group: LocationGroup | string;
  assigned_counter_id: number | null;
  counter_name: string;
  scheduled_date: string;
  status: CountStatus;
  weekly_goal_tag: string;
  items_count: number;
  counted_items_count: number;
  is_overdue: number;
}

interface ApprovedCountRow {
  id: number;
  count_number: string;
  location_name: string;
  location_group: LocationGroup | string;
  counter_name: string;
  scheduled_date: string;
  approved_at: string | null;
  chief_signature_name: string;
  approved_by_name: string;
  is_current_month?: number;
  items_count: number;
  matches_count: number;
  discrepancies_count: number;
  pending_reg_items_count: number;
  adjusted_items_count: number;
  no_adjustment_items_count: number;
  net_economic_diff: number;
  abs_economic_diff: number;
}

interface ExecutiveData {
  quickMetrics: QuickMetrics;
  workflowSummary?: WorkflowSummary;
  trackingAlerts?: TrackingAlert[];
  currentMonth?: string;
  activeCountsByCounter?: ActiveCountsByCounter[];
  monthlyPendingCounts?: MonthlyPendingCountRow[];
  closedCounts?: ApprovedCountRow[];
  general: {
    totalProducts: number;
    totalLocations: number;
    total_counts: number;
    en_ejecucion: number;
    entregados: number;
    rechazados: number;
    aprobados: number;
    compliancePct: number;
  };
  discrepancies: {
    total_counted_lines: number;
    coincidencias: number;
    faltantes: number;
    sobrantes: number;
    faltantes_units: number;
    sobrantes_units: number;
    net_economic_diff: number;
    abs_economic_diff: number;
    matchRatePct: number | null;
    recountRatePct: number;
  };
  recurringProducts: Array<{
    sku: string;
    description: string;
    location_name: string;
    discrepancy_events: number;
    cumulative_diff: number;
  }>;
  locationReliability: Array<{
    id: number;
    name: string;
    group_type: string;
    counts_total: number;
    matches: number;
    discrepancies: number;
  }>;
  counterProductivity: Array<{
    id: number;
    full_name: string;
    total_counts: number;
    completed_counts: number;
    total_items_counted: number;
    recount_items: number;
    avg_hours_execution: number | null;
  }>;
  trendSeries: Array<{
    date: string;
    total_lines: number;
    matches: number;
    discrepancies: number;
  }>;
  adjustedVolumeSeries: Array<{
    date: string;
    adjusted_abs_units: number;
    adjusted_net_units: number;
    positive_units: number;
    negative_units: number;
    adjustment_events: number;
  }>;
}

interface DashboardViewProps {
  currentUser?: AuthUser;
  onNavigate?: (
    tab: 'management' | 'counts' | 'validation',
    options?: { managementStatusFilter?: string }
  ) => void;
}

const DEFAULT_H2_ACCENT = '#580a16';

const H2_ACCENT_PRESETS = [
  { label: 'Borgoña MercoMat', hex: '#580a16' },
  { label: 'Carmesí', hex: '#8e0d0d' },
  { label: 'Dorado', hex: '#d97706' },
  { label: 'Azul Técnico', hex: '#1e40af' },
  { label: 'Esmeralda', hex: '#047857' },
  { label: 'Pizarra', hex: '#334155' },
];

export const DashboardView: React.FC<DashboardViewProps> = ({ currentUser, onNavigate }) => {
  const accentStorageKey = `mercomat_dashboard_h2_accent_${currentUser?.id ?? 'default'}`;
  const [headerAccent, setHeaderAccent] = useState<string>(() => {
    try {
      const saved = window.localStorage.getItem(accentStorageKey);
      return saved && /^#[0-9a-fA-F]{6}$/.test(saved) ? saved : DEFAULT_H2_ACCENT;
    } catch {
      return DEFAULT_H2_ACCENT;
    }
  });
  const [colorPickerOpen, setColorPickerOpen] = useState(false);

  const [locations, setLocations] = useState<Array<{ id: number; name: string }>>([]);
  const [counters, setCounters] = useState<AuthUser[]>([]);
  const [filters, setFilters] = useState({
    dateFrom: '',
    dateTo: '',
    locationId: '',
    counterId: '',
    sku: '',
  });
  const [data, setData] = useState<ExecutiveData | null>(null);
  const [hoveredDayIdx, setHoveredDayIdx] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateHeaderAccent = (hex: string) => {
    setHeaderAccent(hex);
    try {
      window.localStorage.setItem(accentStorageKey, hex);
    } catch {
      // ignore storage quota errors
    }
  };

  const isReadOnlyAudit = currentUser?.role === UserRole.AUDITORIA_DIRECCION;
  const [closedScope, setClosedScope] = useState<'month' | 'all'>(() =>
    currentUser?.role === UserRole.AUDITORIA_DIRECCION ? 'month' : 'all'
  );

  const loadDashboard = async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (filters.dateFrom) qs.set('dateFrom', filters.dateFrom);
      if (filters.dateTo) qs.set('dateTo', filters.dateTo);
      if (filters.locationId) qs.set('locationId', filters.locationId);
      if (filters.counterId) qs.set('counterId', filters.counterId);
      if (filters.sku) qs.set('sku', filters.sku);

      const [execRes, locRes, cntRes] = await Promise.all([
        apiFetch<ExecutiveData>(`/api/dashboard/executive?${qs}`),
        apiFetch<{ locations: Array<{ id: number; name: string }> }>('/api/locations'),
        apiFetch<{ counters: AuthUser[] }>('/api/blind-sheet/counters'),
      ]);
      setData(execRes);
      setLocations(locRes.locations);
      setCounters(cntRes.counters.filter((u) => u.role === UserRole.CONTADOR));
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDashboard();
  }, []);

  const handleExportPdf = async () => {
    if (!data) return;
    setExportingPdf(true);
    setError(null);
    try {
      const locName = filters.locationId
        ? locations.find((l) => String(l.id) === filters.locationId)?.name || 'Ubicación seleccionada'
        : 'Todas las ubicaciones';
      const cntName = filters.counterId
        ? counters.find((c) => String(c.id) === filters.counterId)?.fullName || 'Responsable seleccionado'
        : 'Todos los responsables';

      await exportExecutiveSummaryPdf({
        generatedBy: currentUser?.fullName || 'Jefe de Control de Stock',
        filtersSummary: {
          dateFrom: filters.dateFrom,
          dateTo: filters.dateTo,
          locationName: locName,
          counterName: cntName,
          sku: filters.sku,
        },
        quickMetrics: data.quickMetrics,
        general: data.general,
        discrepancies: data.discrepancies,
        locationReliability: data.locationReliability,
        counterProductivity: data.counterProductivity,
        recurringProducts: data.recurringProducts,
        trendSeries: data.trendSeries,
      });
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setExportingPdf(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 bg-slate-50 border-b border-slate-200">
        <div className="relative bg-slate-50 pb-4 font-bold text-lg">
          <div className="flex flex-wrap items-center gap-3">
            <h2
              className="text-2xl font-bold text-slate-900 border-l-4 pl-3 transition-colors"
              style={{ borderColor: headerAccent }}
            >
              Tablero de Control Gerencial
            </h2>
            <button
              type="button"
              onClick={() => setColorPickerOpen((prev) => !prev)}
              aria-expanded={colorPickerOpen}
              aria-label="Personalizar color de acento del encabezado"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-slate-600 bg-white border border-slate-200 rounded-md hover:border-slate-300 hover:text-slate-900 transition-colors whitespace-nowrap"
              title="Personalizar acento del encabezado"
            >
              <span
                className="w-2.5 h-2.5 rounded-full border border-black/15 shrink-0"
                style={{ backgroundColor: headerAccent }}
              />
              <Palette className="w-3 h-3" />
              <span>Acento</span>
            </button>
          </div>

          {colorPickerOpen && (
            <div className="mt-2 inline-flex flex-wrap items-center gap-2 bg-white border border-slate-200 rounded-lg p-2.5 shadow-md z-20">
              <span className="text-[11px] font-medium text-slate-600 mr-1">
                Color del encabezado:
              </span>
              {H2_ACCENT_PRESETS.map((preset) => {
                const isSelected = headerAccent.toLowerCase() === preset.hex.toLowerCase();
                return (
                  <button
                    key={preset.hex}
                    type="button"
                    onClick={() => updateHeaderAccent(preset.hex)}
                    title={preset.label}
                    aria-label={`Color ${preset.label}`}
                    className={`w-5 h-5 rounded-full border transition-transform ${
                      isSelected ? 'scale-110 ring-2 ring-offset-1 ring-slate-800' : 'border-black/15 hover:scale-105'
                    }`}
                    style={{ backgroundColor: preset.hex }}
                  />
                );
              })}
              <label
                className="inline-flex items-center gap-1 pl-1.5 ml-1 border-l border-slate-200 text-[11px] text-slate-600 cursor-pointer"
                title="Elegir color personalizado"
              >
                <span>Otro</span>
                <input
                  type="color"
                  value={headerAccent}
                  onChange={(e) => updateHeaderAccent(e.target.value)}
                  className="w-6 h-5 p-0 border-0 bg-transparent cursor-pointer"
                  aria-label="Selector de color personalizado para el encabezado"
                />
              </label>
              {headerAccent.toLowerCase() !== DEFAULT_H2_ACCENT && (
                <button
                  type="button"
                  onClick={() => updateHeaderAccent(DEFAULT_H2_ACCENT)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] text-slate-600 hover:text-slate-900 border border-slate-200 rounded"
                  title="Restablecer color original"
                >
                  <RotateCcw className="w-3 h-3" />
                  Restablecer
                </button>
              )}
            </div>
          )}

          <p className="text-sm font-normal text-slate-600 mt-1">
            Indicadores consolidados de cobertura, confiabilidad entre ERP y físico, impacto económico y productividad del equipo.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 shrink-0">
          {currentUser && (
            <div className="text-xs text-slate-500">
              Resumen operativo <span aria-hidden="true">·</span>{' '}
              <span className="font-medium text-slate-700">{currentUser.fullName}</span>
            </div>
          )}
          <button
            type="button"
            onClick={handleExportPdf}
            disabled={loading || !data || exportingPdf}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-[#8e0d0d] text-white rounded-lg hover:bg-[#6e0909] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            {exportingPdf ? 'Generando PDF...' : 'Descargar Resumen Ejecutivo (PDF)'}
          </button>
        </div>
      </div>

      {isReadOnlyAudit && (
        <div className="px-4 py-2.5 bg-slate-100 border border-slate-300 rounded-xl flex flex-wrap items-center justify-between gap-2 text-xs text-slate-800">
          <div className="flex items-center gap-2">
            <Eye className="w-4 h-4 text-[#8e0d0d] shrink-0" />
            <span>
              <strong>Modo Supervisión Ejecutiva (Solo Lectura):</strong> Perfil habilitado para Gerencia General, Auditoría Interna y Dirección. Visualiza estado global de stock, conteos activos por contador, planificados del mes y conteos cerrados sin permisos de modificación.
            </span>
          </div>
          {onNavigate && (
            <button
              type="button"
              onClick={() => onNavigate('management')}
              className="inline-flex items-center gap-1 font-semibold text-[#8e0d0d] hover:underline whitespace-nowrap"
            >
              Ver registro completo de conteos
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      {/* Quick Metrics Card Row */}
      {loading || !data ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-28 bg-white border border-slate-200 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-slate-600">
                    Conteos de Inventario Activos
                  </span>
                  {onNavigate && (
                    <button
                      type="button"
                      onClick={() => onNavigate('management')}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-[#8e0d0d] hover:underline whitespace-nowrap shrink-0"
                    >
                      Gestión de conteos
                      <ArrowRight className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <div className="text-2xl font-mono font-bold text-slate-900 mt-1.5 tabular-nums">
                  {data.quickMetrics.activeInventoryCounts}
                </div>
              </div>
              <div className="text-[11px] text-slate-500 mt-2 tabular-nums">
                {data.quickMetrics.enEjecucion} en ejecución · {data.quickMetrics.rechazados} rechazados ·{' '}
                {data.quickMetrics.activeStockUnits.toLocaleString('es-AR')} u. disp.
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-slate-600">
                    Entregados Pendientes de Revisión
                  </span>
                  {onNavigate && !isReadOnlyAudit && (
                    <button
                      type="button"
                      onClick={() => onNavigate('validation')}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-[#8e0d0d] hover:underline whitespace-nowrap shrink-0"
                    >
                      Bandeja de revisión
                      <ArrowRight className="w-3 h-3" />
                    </button>
                  )}
                  {onNavigate && isReadOnlyAudit && (
                    <button
                      type="button"
                      onClick={() =>
                        onNavigate('management', {
                          managementStatusFilter: CountStatus.ENTREGADO,
                        })
                      }
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-[#8e0d0d] hover:underline whitespace-nowrap shrink-0"
                    >
                      Ver entregados
                      <ArrowRight className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <div
                  className={`text-2xl font-mono font-bold mt-1.5 tabular-nums ${
                    data.quickMetrics.entregados > 0 ? 'text-amber-700' : 'text-slate-900'
                  }`}
                >
                  {data.quickMetrics.entregados}
                </div>
              </div>
              <div className="text-[11px] text-slate-500 mt-2 tabular-nums">
                {data.quickMetrics.entregados} esperando revisión ·{' '}
                {data.quickMetrics.aprobadosPendientesReg} aprobado(s) c/ ajuste ERP pend.
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-slate-600">
                    Conteos Aprobados en el Mes ({data.currentMonth || 'Mes Actual'})
                  </span>
                  {onNavigate && (
                    <button
                      type="button"
                      onClick={() =>
                        onNavigate('management', {
                          managementStatusFilter: CountStatus.APROBADO,
                        })
                      }
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-[#8e0d0d] hover:underline whitespace-nowrap shrink-0"
                    >
                      Ver aprobados
                      <ArrowRight className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <div className="text-2xl font-mono font-bold text-emerald-700 mt-1.5 tabular-nums">
                  {data.quickMetrics.monthlyApprovedCounts ??
                    (data.closedCounts?.filter((c) => Boolean(c.is_current_month)).length || 0)}
                </div>
              </div>
              <div className="text-[11px] text-slate-500 mt-2 tabular-nums">
                {data.general.aprobados} aprobados acumulados · {data.general.compliancePct}% cumplimiento
              </div>
            </div>
          </div>

          {/* 4-State Workflow Tracking Bar */}
          {data.workflowSummary && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-bold text-slate-900">
                    Seguimiento del Circuito de Conteos (Total creados:{' '}
                    <span className="font-mono tabular-nums">
                      {data.workflowSummary.totalCreated}
                    </span>
                    )
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Haga clic en cualquier estado para consultar sus conteos en Gestión de Conteos.
                  </p>
                </div>
                {onNavigate && (
                  <button
                    type="button"
                    onClick={() => onNavigate('management')}
                    className="inline-flex items-center gap-1 text-xs font-medium text-[#8e0d0d] hover:underline"
                  >
                    Abrir Gestión de Conteos
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {(
                  [
                    [CountStatus.EJECUCION, data.workflowSummary.enEjecucion],
                    [CountStatus.ENTREGADO, data.workflowSummary.entregados],
                    [CountStatus.APROBADO, data.workflowSummary.aprobados],
                    [CountStatus.RECHAZADO, data.workflowSummary.rechazados],
                  ] as Array<[CountStatus, number]>
                ).map(([st, countVal]) => {
                  const meta = getCountStatusMeta(st);
                  return (
                    <button
                      key={st}
                      type="button"
                      onClick={() => onNavigate?.('management', { managementStatusFilter: st })}
                      className={`text-left p-2.5 rounded-lg border transition-colors hover:border-slate-400 ${meta.surfaceClass}`}
                    >
                      <div className="flex items-center gap-1.5 text-[11px] font-medium truncate">
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${meta.dotClass}`} />
                        <span className={`truncate ${meta.textClass}`}>{meta.shortLabel}</span>
                      </div>
                      <div className={`text-xl font-mono font-bold mt-1 tabular-nums ${meta.textClass}`}>
                        {countVal}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Active Operational Tracking Alerts */}
          {data.trackingAlerts && data.trackingAlerts.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-900">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                <span>Alertas Activas de Conteos</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {data.trackingAlerts.map((al) => (
                  <div
                    key={al.key}
                    className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg border text-xs ${
                      al.severity === 'CRITICA'
                        ? 'bg-red-50 border-red-200 text-red-900'
                        : al.severity === 'ALTA'
                          ? 'bg-amber-50 border-amber-200 text-amber-900'
                          : 'bg-slate-50 border-slate-200 text-slate-800'
                    }`}
                  >
                    <div className="min-w-0">
                      <span className="font-mono font-bold mr-1.5">[{al.severity}]</span>
                      <span>{al.title}</span>
                    </div>
                    {onNavigate && (
                      <button
                        type="button"
                        onClick={() =>
                          onNavigate(isReadOnlyAudit ? 'management' : al.targetTab, {
                            managementStatusFilter: al.filterStatus || '',
                          })
                        }
                        className="inline-flex items-center gap-1 font-semibold hover:underline shrink-0 whitespace-nowrap"
                      >
                        {isReadOnlyAudit ? 'Consultar' : 'Atender'}
                        <ArrowRight className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Executive Oversight: Active Counts by Counter */}
          {data.activeCountsByCounter && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-[#8e0d0d]" />
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">
                      Conteos Activos por Contador
                    </h3>
                    <p className="text-[11px] text-slate-500">
                      Carga operativa vigente, avance físico y alertas de atraso por responsable de conteo.
                    </p>
                  </div>
                </div>
                {onNavigate && (
                  <button
                    type="button"
                    onClick={() => onNavigate('management')}
                    className="inline-flex items-center gap-1 text-xs font-medium text-[#8e0d0d] hover:underline"
                  >
                    Ir a Gestión de Conteos
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {data.activeCountsByCounter.length === 0 ? (
                <p className="text-xs text-slate-500 py-4 text-center">
                  No hay contadores ni conteos activos para los filtros seleccionados.
                </p>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {data.activeCountsByCounter.map((grp) => (
                    <div
                      key={grp.counterId !== null ? `cnt-${grp.counterId}` : 'cnt-unassigned'}
                      className="border border-slate-200 rounded-lg p-3.5 space-y-2.5 bg-slate-50/40"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="text-xs font-bold text-slate-900">
                            {grp.counterName}
                            {grp.counterUsername && (
                              <span className="ml-1.5 font-mono font-normal text-[11px] text-slate-500">
                                ({grp.counterUsername})
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500 truncate max-w-md">
                            {grp.assignedLocationsLabel}
                          </div>
                        </div>
                        <div className="text-right tabular-nums">
                          <span className="inline-block px-2 py-0.5 text-xs font-mono font-bold bg-white border border-slate-300 rounded text-slate-900">
                            {grp.totalActive} activo(s)
                          </span>
                          {grp.overdueCount > 0 && (
                            <span className="ml-1.5 inline-block px-2 py-0.5 text-[11px] font-mono font-semibold bg-red-50 border border-red-200 rounded text-red-700">
                              {grp.overdueCount} atrasado(s)
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-1.5 text-[11px] text-center tabular-nums">
                        <div className="bg-white border border-slate-200 rounded py-1 px-1">
                          <div className="text-slate-500">En Ejecución</div>
                          <div className="font-mono font-bold text-sky-700">{grp.inExecutionCount}</div>
                        </div>
                        <div className="bg-white border border-slate-200 rounded py-1 px-1">
                          <div className="text-slate-500">Entregados</div>
                          <div className="font-mono font-bold text-amber-700">
                            {grp.deliveredCount}
                          </div>
                        </div>
                        <div className="bg-white border border-slate-200 rounded py-1 px-1">
                          <div className="text-slate-500">Rechazados</div>
                          <div className="font-mono font-bold text-red-700">{grp.rejectedCount}</div>
                        </div>
                      </div>

                      {grp.counts.length === 0 ? (
                        <div className="text-[11px] text-slate-500 italic py-1">
                          Sin conteos activos asignados en este momento.
                        </div>
                      ) : (
                        <div className="bg-white border border-slate-200 rounded divide-y divide-slate-100 max-h-44 overflow-y-auto">
                          {grp.counts.map((c) => {
                            const meta = getCountStatusMeta(c.status);
                            return (
                              <div
                                key={c.id}
                                className="px-2.5 py-1.5 flex items-center justify-between gap-2 text-[11px]"
                              >
                                <div className="min-w-0">
                                  <span className="font-mono font-bold text-slate-900">
                                    {c.count_number}
                                  </span>
                                  <span className="mx-1 text-slate-400">·</span>
                                  <span className="text-slate-700">{c.location_name}</span>
                                  <span className="ml-1.5 font-mono text-slate-500">
                                    ({c.scheduled_date})
                                  </span>
                                  {c.is_overdue && (
                                    <span className="ml-1 font-semibold text-red-700">[Atrasado]</span>
                                  )}
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <span className="font-mono text-slate-500 tabular-nums">
                                    {c.counted_items_count}/{c.items_count}
                                  </span>
                                  <span
                                    className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${meta.surfaceClass} ${meta.textClass}`}
                                  >
                                    {meta.shortLabel}
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Executive Oversight: Planned Counts Pending in Current Month */}
          {data.monthlyPendingCounts && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <CalendarClock className="w-4 h-4 text-[#8e0d0d]" />
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">
                      Conteos Planificados Pendientes del Mes ({data.currentMonth || 'Mes Actual'})
                    </h3>
                    <p className="text-[11px] text-slate-500">
                      Planificaciones del mes corriente que aún no alcanzaron el estado Aprobado.
                    </p>
                  </div>
                </div>
                <span className="text-xs font-mono font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded px-2.5 py-1 tabular-nums">
                  {data.monthlyPendingCounts.length} pendiente(s) en el mes
                </span>
              </div>

              {data.monthlyPendingCounts.length === 0 ? (
                <p className="text-xs text-slate-500 py-5 text-center">
                  No quedan conteos planificados pendientes de aprobación para el mes en curso.
                </p>
              ) : (
                <div className="overflow-x-auto max-h-72 border border-slate-200 rounded-lg">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
                        <th className="py-2 px-3">Nro. Conteo</th>
                        <th className="py-2 px-3">Fecha Prog.</th>
                        <th className="py-2 px-3">Depósito / Ubicación</th>
                        <th className="py-2 px-3">Contador Asignado</th>
                        <th className="py-2 px-3 text-right">Avance</th>
                        <th className="py-2 px-3">Origen / Meta</th>
                        <th className="py-2 px-3">Estado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.monthlyPendingCounts.map((mc) => {
                        const meta = getCountStatusMeta(mc.status);
                        const overdue = Boolean(mc.is_overdue);
                        return (
                          <tr
                            key={mc.id}
                            className={`border-b border-slate-100 ${overdue ? 'bg-red-50/40' : 'hover:bg-slate-50'}`}
                          >
                            <td className="py-2 px-3 font-mono font-bold text-slate-900 whitespace-nowrap">
                              {mc.count_number}
                            </td>
                            <td className="py-2 px-3 font-mono whitespace-nowrap">
                              <span className={overdue ? 'text-red-700 font-semibold' : 'text-slate-700'}>
                                {mc.scheduled_date}
                              </span>
                              {overdue && (
                                <span className="ml-1.5 text-[10px] font-semibold text-red-700">
                                  (Atrasado)
                                </span>
                              )}
                            </td>
                            <td className="py-2 px-3 font-medium text-slate-800 whitespace-nowrap">
                              {mc.location_name}
                            </td>
                            <td className="py-2 px-3 text-slate-700 whitespace-nowrap">
                              {mc.counter_name}
                            </td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                              {mc.counted_items_count}/{mc.items_count}
                            </td>
                            <td className="py-2 px-3 text-slate-600">
                              {mc.weekly_goal_tag || 'Planificación estándar'}
                            </td>
                            <td className="py-2 px-3 whitespace-nowrap">
                              <span
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-semibold ${meta.surfaceClass} ${meta.textClass}`}
                              >
                                <span className={`w-1.5 h-1.5 rounded-sm ${meta.dotClass}`} />
                                {meta.shortLabel}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Executive Oversight: Approved Counts & ERP Regularization Tracking */}
          {data.closedCounts && (() => {
            const visibleApproved =
              closedScope === 'month'
                ? data.closedCounts.filter((cc) => Boolean(cc.is_current_month))
                : data.closedCounts;
            return (
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-700" />
                    <div>
                      <h3 className="text-sm font-bold text-slate-900">
                        {closedScope === 'month'
                          ? `Conteos Aprobados en el Mes (${data.currentMonth || 'Mes Actual'})`
                          : 'Conteos Aprobados y Seguimiento ERP'}
                      </h3>
                      <p className="text-[11px] text-slate-500">
                        Auditorías de inventario aprobadas por Control de Stock y avance del seguimiento de ajustes ERP.
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="inline-flex border border-slate-200 rounded-lg overflow-hidden text-[11px]">
                      <button
                        type="button"
                        onClick={() => setClosedScope('month')}
                        className={`px-2.5 py-1 font-medium ${
                          closedScope === 'month'
                            ? 'bg-slate-900 text-white'
                            : 'bg-white text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        Mes actual ({data.closedCounts.filter((c) => Boolean(c.is_current_month)).length})
                      </button>
                      <button
                        type="button"
                        onClick={() => setClosedScope('all')}
                        className={`px-2.5 py-1 font-medium ${
                          closedScope === 'all'
                            ? 'bg-slate-900 text-white'
                            : 'bg-white text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        Histórico ({data.closedCounts.length})
                      </button>
                    </div>
                    {onNavigate && (
                      <button
                        type="button"
                        onClick={() =>
                          onNavigate('management', { managementStatusFilter: CountStatus.APROBADO })
                        }
                        className="inline-flex items-center gap-1 text-xs font-medium text-[#8e0d0d] hover:underline"
                      >
                        Ver aprobados completos
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {visibleApproved.length === 0 ? (
                  <p className="text-xs text-slate-500 py-5 text-center">
                    {closedScope === 'month'
                      ? 'Aún no hay conteos aprobados durante el mes en curso para los filtros seleccionados.'
                      : 'Aún no hay conteos aprobados para los filtros seleccionados.'}
                  </p>
                ) : (
                  <div className="overflow-x-auto max-h-80 border border-slate-200 rounded-lg">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
                          <th className="py-2 px-3">Nro. Conteo</th>
                          <th className="py-2 px-3">Aprobación</th>
                          <th className="py-2 px-3">Depósito</th>
                          <th className="py-2 px-3">Contador</th>
                          <th className="py-2 px-3">Aprobado por</th>
                          <th className="py-2 px-3 text-right">Coincid. / Ítems</th>
                          <th className="py-2 px-3 text-right">Diferencias</th>
                          <th className="py-2 px-3 text-right">Seguimiento ERP</th>
                          <th className="py-2 px-3 text-right">Impacto Econ.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleApproved.map((cc) => (
                          <tr key={cc.id} className="border-b border-slate-100 hover:bg-slate-50">
                            <td className="py-2 px-3 font-mono font-bold text-slate-900 whitespace-nowrap">
                              {cc.count_number}
                            </td>
                            <td className="py-2 px-3 font-mono text-slate-600 whitespace-nowrap">
                              {cc.approved_at ? String(cc.approved_at).slice(0, 16).replace('T', ' ') : cc.scheduled_date}
                            </td>
                            <td className="py-2 px-3 font-medium text-slate-800 whitespace-nowrap">
                              {cc.location_name}
                            </td>
                            <td className="py-2 px-3 text-slate-700 whitespace-nowrap">
                              {cc.counter_name}
                            </td>
                            <td className="py-2 px-3 text-slate-700 whitespace-nowrap">
                              {cc.approved_by_name || cc.chief_signature_name}
                            </td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                              {cc.matches_count}/{cc.items_count}
                            </td>
                            <td className="py-2 px-3 text-right font-mono font-semibold tabular-nums whitespace-nowrap">
                              <span className={cc.discrepancies_count > 0 ? 'text-red-700' : 'text-emerald-700'}>
                                {cc.discrepancies_count}
                              </span>
                            </td>
                            <td className="py-2 px-3 text-right font-mono text-[11px] text-slate-600 tabular-nums whitespace-nowrap">
                              {cc.adjusted_items_count} aj. / {cc.no_adjustment_items_count} s/aj.
                              {cc.pending_reg_items_count > 0 ? ` / ${cc.pending_reg_items_count} pend.` : ''}
                            </td>
                            <td className="py-2 px-3 text-right font-mono font-semibold tabular-nums whitespace-nowrap text-slate-900">
                              ${Math.abs(Number(cc.abs_economic_diff || 0)).toLocaleString('es-AR', {
                                maximumFractionDigits: 0,
                              })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* Filters */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-end gap-3 text-xs">
        <div>
          <label className="block text-slate-600 mb-1">Desde</label>
          <input
            type="date"
            value={filters.dateFrom}
            onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })}
            className="px-2.5 py-1.5 border border-slate-300 rounded-lg font-mono"
          />
        </div>
        <div>
          <label className="block text-slate-600 mb-1">Hasta</label>
          <input
            type="date"
            value={filters.dateTo}
            onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })}
            className="px-2.5 py-1.5 border border-slate-300 rounded-lg font-mono"
          />
        </div>
        <div>
          <label className="block text-slate-600 mb-1">Ubicación</label>
          <select
            value={filters.locationId}
            onChange={(e) => setFilters({ ...filters, locationId: e.target.value })}
            className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
          >
            <option value="">Todas (11+)</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-slate-600 mb-1">Responsable</label>
          <select
            value={filters.counterId}
            onChange={(e) => setFilters({ ...filters, counterId: e.target.value })}
            className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
          >
            <option value="">Todos</option>
            {counters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.fullName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-slate-600 mb-1">Artículo (Código)</label>
          <input
            type="text"
            value={filters.sku}
            onChange={(e) => setFilters({ ...filters, sku: e.target.value })}
            placeholder="SKU..."
            className="w-32 px-2.5 py-1.5 border border-slate-300 rounded-lg font-mono"
          />
        </div>
        <button
          onClick={loadDashboard}
          className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-[#8e0d0d] text-white rounded-lg font-medium hover:bg-[#6e0909]"
        >
          <Filter className="w-3.5 h-3.5" />
          Aplicar Filtros
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
          {error}
        </div>
      )}

      {loading || !data ? (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="h-24 bg-white border border-slate-200 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : (
        <>
          {/* General & Reliability KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Artículos / Ubicaciones</div>
              <div className="text-2xl font-mono font-bold text-slate-900 mt-1 tabular-nums">
                {data.general.totalProducts} / {data.general.totalLocations}
              </div>
              <div className="text-[11px] text-slate-500 mt-1">
                {data.general.totalProducts === 0
                  ? 'Pendiente de importación Excel ERP'
                  : 'Maestro centralizado activo'}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Cumplimiento del Plan</div>
              <div className="text-2xl font-mono font-bold text-slate-900 mt-1 tabular-nums">
                {data.general.compliancePct}%
              </div>
              <div className="text-[11px] text-slate-500 mt-1 tabular-nums">
                {data.general.aprobados} aprobados · {data.general.entregados} entregados ·{' '}
                {data.general.en_ejecucion + data.general.rechazados} activos
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Confiabilidad ERP vs Físico</div>
              <div className="text-2xl font-mono font-bold text-emerald-700 mt-1 tabular-nums">
                {data.discrepancies.matchRatePct !== null
                  ? `${data.discrepancies.matchRatePct}%`
                  : 'Sin conteos'}
              </div>
              <div className="text-[11px] text-slate-500 mt-1 tabular-nums">
                {data.discrepancies.coincidencias || 0} coincidencias · Reconteo:{' '}
                {data.discrepancies.recountRatePct}%
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Impacto Económico Diferencias</div>
              <div className="text-2xl font-mono font-bold text-red-700 mt-1 tabular-nums">
                $
                {Math.abs(data.discrepancies.abs_economic_diff || 0).toLocaleString('es-AR', {
                  maximumFractionDigits: 0,
                })}
              </div>
              <div className="text-[11px] text-slate-500 mt-1 tabular-nums">
                Faltantes: {data.discrepancies.faltantes || 0} ({data.discrepancies.faltantes_units || 0} u.) ·
                Sobrantes: {data.discrepancies.sobrantes || 0} ({data.discrepancies.sobrantes_units || 0} u.)
              </div>
            </div>
          </div>

          {/* 30-Day Adjusted Inventory Volume Line Chart */}
          {(() => {
            const series = data.adjustedVolumeSeries || [];
            const totalUnits30d = series.reduce((s, d) => s + d.adjusted_abs_units, 0);
            const totalEvents30d = series.reduce((s, d) => s + d.adjustment_events, 0);
            const rawMax = Math.max(...series.map((d) => d.adjusted_abs_units), 0);
            const yMax = rawMax > 0 ? Math.ceil(rawMax * 1.15) : 10;

            const svgW = 860;
            const svgH = 220;
            const padL = 50;
            const padR = 16;
            const padT = 16;
            const padB = 32;
            const plotW = svgW - padL - padR;
            const plotH = svgH - padT - padB;
            const n = series.length;

            const coords = series.map((pt, idx) => {
              const x = padL + (n > 1 ? (idx / (n - 1)) * plotW : plotW / 2);
              const y = padT + plotH - (pt.adjusted_abs_units / yMax) * plotH;
              return { ...pt, x, y, idx };
            });

            const linePath = coords
              .map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x.toFixed(1)},${c.y.toFixed(1)}`)
              .join(' ');
            const areaPath =
              coords.length > 0
                ? `${linePath} L ${coords[coords.length - 1].x.toFixed(1)},${(padT + plotH).toFixed(1)} L ${coords[0].x.toFixed(1)},${(padT + plotH).toFixed(1)} Z`
                : '';

            const activeIdx =
              hoveredDayIdx !== null && hoveredDayIdx >= 0 && hoveredDayIdx < coords.length
                ? hoveredDayIdx
                : coords.length - 1;
            const activePt = coords[activeIdx];
            const yTicks = [0, 0.33, 0.66, 1].map((frac) => ({
              value: Math.round(yMax * frac * 10) / 10,
              y: padT + plotH - frac * plotH,
            }));

            return (
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
                    <TrendingUp className="w-4 h-4 text-[#8e0d0d]" />
                    <span>Volumen de Inventario Ajustado — Tendencia 30 Días</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600 tabular-nums">
                    <span>
                      Total 30d:{' '}
                      <strong className="font-mono text-slate-900">
                        {totalUnits30d.toLocaleString('es-AR', { maximumFractionDigits: 2 })} u.
                      </strong>
                    </span>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span>
                      Pico diario:{' '}
                      <strong className="font-mono text-slate-900">
                        {rawMax.toLocaleString('es-AR', { maximumFractionDigits: 2 })} u.
                      </strong>
                    </span>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span>
                      Ajustes aplicados:{' '}
                      <strong className="font-mono text-slate-900">{totalEvents30d}</strong>
                    </span>
                  </div>
                </div>

                {activePt && (
                  <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs tabular-nums">
                    <div className="font-mono font-semibold text-slate-900">
                      Día seleccionado: {activePt.date}
                    </div>
                    <div className="flex flex-wrap items-center gap-4 text-slate-700">
                      <span>
                        Volumen ajustado:{' '}
                        <strong className="font-mono text-[#8e0d0d]">
                          {activePt.adjusted_abs_units.toLocaleString('es-AR')} u.
                        </strong>
                      </span>
                      <span>
                        Altas (+):{' '}
                        <strong className="font-mono text-emerald-700">
                          +{activePt.positive_units.toLocaleString('es-AR')}
                        </strong>
                      </span>
                      <span>
                        Bajas (-):{' '}
                        <strong className="font-mono text-red-700">
                          -{activePt.negative_units.toLocaleString('es-AR')}
                        </strong>
                      </span>
                      <span>
                        Movimientos:{' '}
                        <strong className="font-mono text-slate-900">
                          {activePt.adjustment_events}
                        </strong>
                      </span>
                    </div>
                  </div>
                )}

                <div className="w-full overflow-x-auto">
                  <svg
                    viewBox={`0 0 ${svgW} ${svgH}`}
                    className="w-full min-w-[600px] h-52 select-none"
                    role="img"
                    aria-label="Gráfico de líneas del volumen de inventario ajustado en los últimos 30 días"
                    onMouseLeave={() => setHoveredDayIdx(null)}
                  >
                    <defs>
                      <linearGradient id="mercomatAdjArea" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#8e0d0d" stopOpacity="0.18" />
                        <stop offset="100%" stopColor="#8e0d0d" stopOpacity="0.01" />
                      </linearGradient>
                    </defs>

                    {/* Horizontal Gridlines & Y-Axis Labels */}
                    {yTicks.map((t, i) => (
                      <g key={i}>
                        <line
                          x1={padL}
                          y1={t.y}
                          x2={svgW - padR}
                          y2={t.y}
                          stroke="#e2e8f0"
                          strokeDasharray={i === 0 ? undefined : '3 3'}
                          strokeWidth="1"
                        />
                        <text
                          x={padL - 8}
                          y={t.y + 3.5}
                          textAnchor="end"
                          className="fill-slate-500 text-[10px] font-mono"
                        >
                          {t.value}
                        </text>
                      </g>
                    ))}

                    {/* Area Fill */}
                    {areaPath && <path d={areaPath} fill="url(#mercomatAdjArea)" />}

                    {/* Main Line */}
                    {linePath && (
                      <path
                        d={linePath}
                        fill="none"
                        stroke="#8e0d0d"
                        strokeWidth="2.25"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    )}

                    {/* Vertical Hover Guide */}
                    {activePt && (
                      <line
                        x1={activePt.x}
                        y1={padT}
                        x2={activePt.x}
                        y2={padT + plotH}
                        stroke="#94a3b8"
                        strokeDasharray="3 3"
                        strokeWidth="1"
                      />
                    )}

                    {/* Data Points & X-Axis Labels */}
                    {coords.map((c) => {
                      const isActive = activePt?.idx === c.idx;
                      const showLabel = c.idx === 0 || c.idx === coords.length - 1 || c.idx % 5 === 0;
                      const shortDate = `${c.date.slice(8, 10)}/${c.date.slice(5, 7)}`;
                      const hitWidth = coords.length > 1 ? plotW / (coords.length - 1) : plotW;

                      return (
                        <g key={c.date}>
                          {(c.adjusted_abs_units > 0 || isActive) && (
                            <circle
                              cx={c.x}
                              cy={c.y}
                              r={isActive ? 4.5 : 3}
                              fill={isActive ? '#fbc016' : '#8e0d0d'}
                              stroke="#8e0d0d"
                              strokeWidth={isActive ? 2 : 1.5}
                            />
                          )}
                          {showLabel && (
                            <text
                              x={c.x}
                              y={svgH - 10}
                              textAnchor="middle"
                              className="fill-slate-500 text-[10px] font-mono"
                            >
                              {shortDate}
                            </text>
                          )}
                          <rect
                            x={c.x - hitWidth / 2}
                            y={padT}
                            width={hitWidth}
                            height={plotH}
                            fill="transparent"
                            className="cursor-pointer"
                            onMouseEnter={() => setHoveredDayIdx(c.idx)}
                            onClick={() => setHoveredDayIdx(c.idx)}
                          />
                        </g>
                      );
                    })}
                  </svg>
                </div>

                {totalUnits30d === 0 && (
                  <p className="text-[11px] text-slate-500 text-center">
                    No se registraron ajustes de inventario ERP en los últimos 30 días para los filtros seleccionados; al cerrar conteos con regularización se reflejarán en esta línea temporal.
                  </p>
                )}
              </div>
            );
          })()}

          {/* Trend SVG + Location Reliability */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
                <BarChart3 className="w-4 h-4 text-[#8e0d0d]" />
                <span>Evolución Histórica de Coincidencia y Diferencias</span>
              </div>
              {data.trendSeries.length === 0 ? (
                <p className="text-xs text-slate-500 py-8 text-center">
                  Aún no existen conteos conciliados para graficar evolución histórica.
                </p>
              ) : (
                <div className="space-y-2">
                  {data.trendSeries.map((pt) => {
                    const rate =
                      pt.total_lines > 0 ? Math.round((pt.matches / pt.total_lines) * 100) : 0;
                    return (
                      <div key={pt.date} className="text-xs space-y-1">
                        <div className="flex justify-between font-mono text-[11px]">
                          <span>{pt.date}</span>
                          <span>
                            {rate}% coincidencia ({pt.matches}/{pt.total_lines} líneas ·{' '}
                            {pt.discrepancies} dif.)
                          </span>
                        </div>
                        <div className="w-full h-2 bg-slate-100 rounded overflow-hidden">
                          <div
                            className="h-full bg-[#8e0d0d]"
                            style={{ width: `${rate}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <h3 className="text-sm font-bold text-slate-900">
                Confiabilidad e Incidencias por Ubicación
              </h3>
              <div className="overflow-x-auto max-h-64">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-500">
                      <th className="py-1.5">Ubicación</th>
                      <th className="py-1.5 text-right">Conteos</th>
                      <th className="py-1.5 text-right">Incidencias</th>
                      <th className="py-1.5 text-right">Confiabilidad</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.locationReliability.map((loc) => {
                      const total = (loc.matches || 0) + (loc.discrepancies || 0);
                      const pct = total > 0 ? Math.round((loc.matches / total) * 1000) / 10 : null;
                      return (
                        <tr key={loc.id} className="border-b border-slate-100">
                          <td className="py-1.5 font-medium text-slate-900">{loc.name}</td>
                          <td className="py-1.5 text-right font-mono tabular-nums">
                            {loc.counts_total}
                          </td>
                          <td className="py-1.5 text-right font-mono tabular-nums text-red-700">
                            {loc.discrepancies || 0}
                          </td>
                          <td className="py-1.5 text-right font-mono font-semibold tabular-nums">
                            {pct !== null ? `${pct}%` : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Counter Productivity + Recurring Discrepancies */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <h3 className="text-sm font-bold text-slate-900">
                Productividad por Responsable de Conteo
              </h3>
              {data.counterProductivity.length === 0 ? (
                <p className="text-xs text-slate-500">
                  No hay usuarios con rol Responsable de Conteo registrados.
                </p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-500">
                      <th className="py-1.5">Responsable</th>
                      <th className="py-1.5 text-right">Conteos</th>
                      <th className="py-1.5 text-right">Ítems Contados</th>
                      <th className="py-1.5 text-right">Reconteos</th>
                      <th className="py-1.5 text-right">Prom. Hs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.counterProductivity.map((cp) => (
                      <tr key={cp.id} className="border-b border-slate-100">
                        <td className="py-1.5 font-medium text-slate-900">{cp.full_name}</td>
                        <td className="py-1.5 text-right font-mono tabular-nums">
                          {cp.completed_counts}/{cp.total_counts}
                        </td>
                        <td className="py-1.5 text-right font-mono tabular-nums">
                          {cp.total_items_counted}
                        </td>
                        <td className="py-1.5 text-right font-mono tabular-nums">
                          {cp.recount_items}
                        </td>
                        <td className="py-1.5 text-right font-mono tabular-nums">
                          {cp.avg_hours_execution !== null ? `${cp.avg_hours_execution}h` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <h3 className="text-sm font-bold text-slate-900">
                Artículos con Diferencias Recurrentes
              </h3>
              {data.recurringProducts.length === 0 ? (
                <p className="text-xs text-slate-500">
                  No se detectan artículos con diferencias acumuladas.
                </p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-500">
                      <th className="py-1.5">Código / Artículo</th>
                      <th className="py-1.5">Ubicación</th>
                      <th className="py-1.5 text-right">Eventos</th>
                      <th className="py-1.5 text-right">Dif. Acum.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recurringProducts.map((rp, i) => (
                      <tr key={i} className="border-b border-slate-100">
                        <td className="py-1.5">
                          <span className="font-mono font-semibold">{rp.sku}</span> ·{' '}
                          {rp.description}
                        </td>
                        <td className="py-1.5 text-slate-600">{rp.location_name}</td>
                        <td className="py-1.5 text-right font-mono tabular-nums">
                          {rp.discrepancy_events}
                        </td>
                        <td className="py-1.5 text-right font-mono font-semibold tabular-nums text-red-700">
                          {rp.cumulative_diff > 0 ? `+${rp.cumulative_diff}` : rp.cumulative_diff}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};
