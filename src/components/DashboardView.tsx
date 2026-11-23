import React, { useEffect, useState } from 'react';
import { ArrowRight, BarChart3, Download, Filter, TrendingUp } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { exportExecutiveSummaryPdf } from '../lib/pdfExport';
import { AuthUser, UserRole } from '../types/erp';

interface QuickMetrics {
  activeInventoryCounts: number;
  programados: number;
  enProgreso: number;
  reconteos: number;
  activeStockUnits: number;
  pendingValidations: number;
  awaitingClosure: number;
  userDailySalesAmount: number;
  userDailySalesCount: number;
  userDailySalesUnits: number;
  teamDailySalesAmount: number;
  teamDailySalesCount: number;
}

interface ExecutiveData {
  quickMetrics: QuickMetrics;
  general: {
    totalProducts: number;
    totalLocations: number;
    total_counts: number;
    programados: number;
    en_progreso: number;
    en_revision: number;
    validados: number;
    cerrados: number;
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
  onNavigate?: (tab: 'counts' | 'validation' | 'pos') => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({ currentUser, onNavigate }) => {
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

      const [execRes, locRes, usrRes] = await Promise.all([
        apiFetch<ExecutiveData>(`/api/dashboard/executive?${qs}`),
        apiFetch<{ locations: Array<{ id: number; name: string }> }>('/api/locations'),
        apiFetch<{ users: AuthUser[] }>('/api/users'),
      ]);
      setData(execRes);
      setLocations(locRes.locations);
      setCounters(usrRes.users.filter((u) => u.role === UserRole.CONTADOR));
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
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Tablero de Control Gerencial</h2>
          <p className="text-sm text-slate-600 mt-0.5">
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

      {/* Quick Metrics Card Row */}
      {loading || !data ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-28 bg-white border border-slate-200 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : (
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
                    onClick={() => onNavigate('counts')}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-[#8e0d0d] hover:underline whitespace-nowrap shrink-0"
                  >
                    Ver conteos
                    <ArrowRight className="w-3 h-3" />
                  </button>
                )}
              </div>
              <div className="text-2xl font-mono font-bold text-slate-900 mt-1.5 tabular-nums">
                {data.quickMetrics.activeInventoryCounts}
              </div>
            </div>
            <div className="text-[11px] text-slate-500 mt-2 tabular-nums">
              {data.quickMetrics.programados} programados · {data.quickMetrics.enProgreso} en progreso ·{' '}
              {data.quickMetrics.reconteos} reconteo ·{' '}
              {data.quickMetrics.activeStockUnits.toLocaleString('es-AR')} u. disp.
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-600">Validaciones Pendientes</span>
                {onNavigate && (
                  <button
                    type="button"
                    onClick={() => onNavigate('validation')}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-[#8e0d0d] hover:underline whitespace-nowrap shrink-0"
                  >
                    Revisar
                    <ArrowRight className="w-3 h-3" />
                  </button>
                )}
              </div>
              <div
                className={`text-2xl font-mono font-bold mt-1.5 tabular-nums ${
                  data.quickMetrics.pendingValidations > 0 ? 'text-amber-700' : 'text-slate-900'
                }`}
              >
                {data.quickMetrics.pendingValidations}
              </div>
            </div>
            <div className="text-[11px] text-slate-500 mt-2 tabular-nums">
              {data.quickMetrics.pendingValidations} esperando revisión ·{' '}
              {data.quickMetrics.awaitingClosure} validado(s) por cerrar
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-600">
                  Ventas Diarias ({currentUser ? currentUser.username : 'Usuario'})
                </span>
                {onNavigate && (
                  <button
                    type="button"
                    onClick={() => onNavigate('pos')}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-[#8e0d0d] hover:underline whitespace-nowrap shrink-0"
                  >
                    Ir al POS
                    <ArrowRight className="w-3 h-3" />
                  </button>
                )}
              </div>
              <div className="text-2xl font-mono font-bold text-[#8e0d0d] mt-1.5 tabular-nums">
                $
                {data.quickMetrics.userDailySalesAmount.toLocaleString('es-AR', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </div>
            </div>
            <div className="text-[11px] text-slate-500 mt-2 tabular-nums">
              {data.quickMetrics.userDailySalesCount} venta(s) ·{' '}
              {data.quickMetrics.userDailySalesUnits} u. hoy · Global hoy: $
              {data.quickMetrics.teamDailySalesAmount.toLocaleString('es-AR', {
                maximumFractionDigits: 0,
              })}
            </div>
          </div>
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
                {data.general.cerrados} cerrados · {data.general.en_revision} en revisión ·{' '}
                {data.general.programados + data.general.en_progreso} pend.
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
