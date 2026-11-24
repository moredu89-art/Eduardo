import React, { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  ClipboardList,
  Download,
  Eye,
  Filter,
  History,
  Layers,
  Paperclip,
  RotateCcw,
  UserPlus,
  X,
} from 'lucide-react';
import { apiFetch, getAuthToken } from '../lib/api';
import { COUNT_STATUS_LIST, getCountStatusMeta } from '../lib/countStatus';
import { AuthUser, CountStatus, LocationGroup, UserRole } from '../types/erp';

interface ManagedCountRow {
  id: number;
  count_number: string;
  document_uid: string;
  location_id: number;
  location_name: string;
  location_code: string;
  location_group: LocationGroup;
  scheduled_date: string;
  assigned_counter_id: number | null;
  counter_name: string;
  warehouse_manager_name: string | null;
  created_by_name?: string;
  status: CountStatus;
  items_count: number;
  counted_items_count: number;
  not_counted_items_count: number;
  discrepancies_count: number | null;
  submissions_count: number;
  attachments_count: number;
  executed_at: string | null;
  submitted_at: string | null;
  rejected_at: string | null;
  rejection_reason: string;
  approved_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CountDetailPayload {
  count: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  isBlindRestricted: boolean;
  postSnapshotMovements: Array<Record<string, unknown>>;
  sheetAttachments: Array<{ id: number; original_name: string; mime_type: string; created_at: string }>;
  stateHistory: Array<{
    id: number;
    previous_status: string | null;
    new_status: string;
    changed_by_username: string;
    changed_by_full_name: string | null;
    reason: string;
    created_at: string;
  }>;
  submissions: Array<{
    id: number;
    version_number: number;
    submitted_by_full_name: string | null;
    submitted_by_username: string;
    counter_signature_name: string;
    warehouse_signature_name: string;
    general_observations: string;
    outcome_status: string;
    reviewed_by_full_name: string | null;
    review_notes: string;
    reviewed_at: string | null;
    created_at: string;
    items: Array<Record<string, unknown>>;
  }>;
}

interface CountsManagementViewProps {
  currentUser: AuthUser;
  initialStatusFilter?: string;
  onOpenExecution?: (countId: number) => void;
  onOpenValidation?: (countId: number) => void;
}

function formatDateTimeShort(val: unknown): string {
  if (!val) return '—';
  const s = String(val);
  return s.replace('T', ' ').slice(0, 16);
}

export const CountsManagementView: React.FC<CountsManagementViewProps> = ({
  currentUser,
  initialStatusFilter = '',
  onOpenExecution,
  onOpenValidation,
}) => {
  const [counts, setCounts] = useState<ManagedCountRow[]>([]);
  const [locations, setLocations] = useState<Array<{ id: number; name: string; groupType: LocationGroup }>>([]);
  const [counters, setCounters] = useState<AuthUser[]>([]);

  const [filters, setFilters] = useState({
    status: initialStatusFilter,
    locationGroup: '',
    locationId: '',
    counterId: '',
    dateFrom: '',
    dateTo: '',
    countNumber: '',
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [detailModal, setDetailModal] = useState<CountDetailPayload | null>(null);
  const [detailTab, setDetailTab] = useState<'items' | 'history' | 'versions'>('items');
  const [assignModalCount, setAssignModalCount] = useState<ManagedCountRow | null>(null);
  const [assignCounterId, setAssignCounterId] = useState<string>('');
  const [assignReason, setAssignReason] = useState<string>('');
  const [assigning, setAssigning] = useState(false);

  const loadData = async (overrideFilters?: typeof filters) => {
    const active = overrideFilters || filters;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (active.status) qs.set('status', active.status);
      if (active.locationGroup) qs.set('locationGroup', active.locationGroup);
      if (active.locationId) qs.set('locationId', active.locationId);
      if (active.counterId) qs.set('counterId', active.counterId);
      if (active.dateFrom) qs.set('dateFrom', active.dateFrom);
      if (active.dateTo) qs.set('dateTo', active.dateTo);
      if (active.countNumber.trim()) qs.set('countNumber', active.countNumber.trim());

      const requests: [
        Promise<{ counts: ManagedCountRow[] }>,
        Promise<{ locations: Array<{ id: number; name: string; groupType: LocationGroup }> }>,
        Promise<{ users: AuthUser[] } | null>,
        Promise<{ counters: AuthUser[] } | null>,
      ] = [
        apiFetch<{ counts: ManagedCountRow[] }>(`/api/counts?${qs}`),
        apiFetch<{ locations: Array<{ id: number; name: string; groupType: LocationGroup }> }>('/api/locations'),
        currentUser.role === UserRole.JEFE_STOCK
          ? apiFetch<{ users: AuthUser[] }>('/api/users')
          : Promise.resolve(null),
        currentUser.role === UserRole.AUDITORIA_DIRECCION
          ? apiFetch<{ counters: AuthUser[] }>('/api/blind-sheet/counters')
          : Promise.resolve(null),
      ];

      const [countsRes, locRes, usersRes, countersRes] = await Promise.all(requests);
      setCounts(countsRes.counts);
      setLocations(locRes.locations);
      if (usersRes) {
        setCounters(usersRes.users.filter((u) => u.role === UserRole.CONTADOR && u.isActive));
      } else if (countersRes) {
        setCounters(countersRes.counters.filter((u) => u.role === UserRole.CONTADOR));
      }
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setFilters((prev) => ({ ...prev, status: initialStatusFilter || '' }));
    loadData({ ...filters, status: initialStatusFilter || '' });
  }, [initialStatusFilter]);

  const handleOpenDetail = async (id: number) => {
    setError(null);
    setDetailTab('items');
    try {
      const res = await apiFetch<CountDetailPayload>(`/api/counts/${id}`);
      setDetailModal(res);
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const handleDownloadAttachment = async (attId: number, originalName: string) => {
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/attachments/${attId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error('No se pudo descargar el adjunto.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = originalName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const handleAssignSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assignModalCount || !assignCounterId) return;
    setAssigning(true);
    setError(null);
    try {
      await apiFetch(`/api/counts/${assignModalCount.id}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          assignedCounterId: Number(assignCounterId),
          reason: assignReason,
        }),
      });
      setMessage(`Conteo ${assignModalCount.count_number} asignado y listo en estado EJECUCIÓN.`);
      setAssignModalCount(null);
      setAssignCounterId('');
      setAssignReason('');
      await loadData();
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setAssigning(false);
    }
  };

  const handleResetFilters = () => {
    const empty = {
      status: '',
      locationGroup: '',
      locationId: '',
      counterId: '',
      dateFrom: '',
      dateTo: '',
      countNumber: '',
    };
    setFilters(empty);
    loadData(empty);
  };

  // Summary counts across all 4 states
  const stateBreakdown = COUNT_STATUS_LIST.map((st) => ({
    meta: getCountStatusMeta(st),
    total: counts.filter((c) => c.status === st).length,
  }));

  const isJefe = currentUser.role === UserRole.JEFE_STOCK;
  const isAuditor = currentUser.role === UserRole.AUDITORIA_DIRECCION;
  const isContador = currentUser.role === UserRole.CONTADOR;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Gestión y Seguimiento de Conteos</h2>
          <p className="text-sm text-slate-600 mt-0.5">
            Panel centralizado de trazabilidad de conteos cíclicos, estados operativos, versiones presentadas e histórico completo.
          </p>
        </div>
        <div className="text-xs text-slate-600 tabular-nums font-medium bg-white border border-slate-200 rounded-lg px-3 py-2">
          Total en vista: <strong className="font-mono text-slate-900">{counts.length}</strong> conteo(s)
        </div>
      </div>

      {/* 4-State Pipeline Strip (Clickable quick filter) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {stateBreakdown.map(({ meta, total }) => {
          const isSelected = filters.status === meta.status;
          return (
            <button
              key={meta.status}
              type="button"
              onClick={() => {
                const nextStatus = isSelected ? '' : meta.status;
                const next = { ...filters, status: nextStatus };
                setFilters(next);
                loadData(next);
              }}
              className={`text-left p-2.5 rounded-lg border transition-colors ${
                isSelected
                  ? 'border-[#8e0d0d] bg-red-50/40 ring-1 ring-[#8e0d0d]/25'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-700 truncate">
                  <span className={`w-2 h-2 rounded-sm shrink-0 ${meta.dotClass}`} />
                  {meta.shortLabel}
                </span>
                <span className="text-[10px] font-mono text-slate-400">{meta.step}/4</span>
              </div>
              <div className="text-lg font-mono font-bold text-slate-900 mt-1 tabular-nums">
                {total}
              </div>
            </button>
          );
        })}
      </div>

      {/* Comprehensive Filters Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 text-xs">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-slate-600 mb-1 font-medium">Nro. Conteo</label>
            <input
              type="text"
              value={filters.countNumber}
              onChange={(e) => setFilters({ ...filters, countNumber: e.target.value })}
              placeholder="Ej. CNT-0001"
              className="w-32 px-2.5 py-1.5 border border-slate-300 rounded-lg font-mono"
            />
          </div>

          <div>
            <label className="block text-slate-600 mb-1 font-medium">Estado</label>
            <select
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
            >
              <option value="">Todos los estados</option>
              {COUNT_STATUS_LIST.map((st) => {
                const m = getCountStatusMeta(st);
                return (
                  <option key={st} value={st}>
                    {m.step}. {m.label}
                  </option>
                );
              })}
            </select>
          </div>

          <div>
            <label className="block text-slate-600 mb-1 font-medium">Ubicación</label>
            <select
              value={filters.locationGroup}
              onChange={(e) => setFilters({ ...filters, locationGroup: e.target.value })}
              className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
            >
              <option value="">Todas</option>
              <option value={LocationGroup.CASA_CENTRAL}>Casa Central</option>
              <option value={LocationGroup.SUCURSAL}>Sucursal</option>
            </select>
          </div>

          <div>
            <label className="block text-slate-600 mb-1 font-medium">Depósito</label>
            <select
              value={filters.locationId}
              onChange={(e) => setFilters({ ...filters, locationId: e.target.value })}
              className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white"
            >
              <option value="">Todos los depósitos</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>

          {(isJefe || isAuditor) && (
            <div>
              <label className="block text-slate-600 mb-1 font-medium">Responsable</label>
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
          )}

          <div>
            <label className="block text-slate-600 mb-1 font-medium">Fecha Desde</label>
            <input
              type="date"
              value={filters.dateFrom}
              onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })}
              className="px-2.5 py-1.5 border border-slate-300 rounded-lg font-mono"
            />
          </div>

          <div>
            <label className="block text-slate-600 mb-1 font-medium">Fecha Hasta</label>
            <input
              type="date"
              value={filters.dateTo}
              onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })}
              className="px-2.5 py-1.5 border border-slate-300 rounded-lg font-mono"
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => loadData()}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-[#8e0d0d] text-white rounded-lg font-medium hover:bg-[#6e0909]"
            >
              <Filter className="w-3.5 h-3.5" />
              Filtrar
            </button>
            <button
              type="button"
              onClick={handleResetFilters}
              className="inline-flex items-center gap-1 px-3 py-1.5 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Limpiar
            </button>
          </div>
        </div>
      </div>

      {message && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800">
          {message}
        </div>
      )}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
          {error}
        </div>
      )}

      {/* Centralized Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <ClipboardList className="w-4 h-4 text-[#8e0d0d]" />
            <span>Registro Centralizado de Conteos ({counts.length})</span>
          </div>
          <span className="text-[11px] text-slate-500">
            Incluye conteos en ejecución, entregados, rechazados y aprobados
          </span>
        </div>

        {loading ? (
          <div className="p-10 text-center text-xs text-slate-500">Cargando conteos...</div>
        ) : counts.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-500">
            No se encontraron conteos para los criterios seleccionados.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
                  <th className="py-2.5 px-3 whitespace-nowrap">Nro. Conteo</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Creación</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Ubicación</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Depósito</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Responsable Asignado</th>
                  <th className="py-2.5 px-3 text-right whitespace-nowrap">Artículos</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Ejecución</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Presentación</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Estado Actual</th>
                  <th className="py-2.5 px-3 whitespace-nowrap">Última Act.</th>
                  <th className="py-2.5 px-3 text-right whitespace-nowrap">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {counts.map((c) => {
                  const meta = getCountStatusMeta(c.status);
                  const isOverdue =
                    c.status !== CountStatus.APROBADO &&
                    c.scheduled_date < new Date().toISOString().slice(0, 10);

                  return (
                    <tr key={c.id} className="border-b border-slate-100 hover:bg-slate-50/70">
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <div className="font-mono font-bold text-slate-900">{c.count_number}</div>
                        <div className="text-[10px] font-mono text-slate-500">
                          Prog: {c.scheduled_date}
                          {isOverdue && (
                            <span className="ml-1 text-red-700 font-semibold">(Atrasado)</span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px] text-slate-600 whitespace-nowrap">
                        {formatDateTimeShort(c.created_at)}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap text-slate-700">
                        {c.location_group === LocationGroup.CASA_CENTRAL ? 'Casa Central' : 'Sucursal'}
                      </td>
                      <td className="py-2.5 px-3 font-medium text-slate-900 whitespace-nowrap">
                        {c.location_name}
                      </td>
                      <td className="py-2.5 px-3 text-slate-700 whitespace-nowrap">
                        {c.assigned_counter_id ? (
                          c.counter_name
                        ) : (
                          <span className="text-slate-400 italic">Sin asignar</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                        <span className="font-semibold text-slate-900">{c.items_count}</span>
                        <span className="text-[10px] text-slate-500 block">
                          {c.counted_items_count}/{c.items_count} inf.
                        </span>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px] text-slate-600 whitespace-nowrap">
                        {formatDateTimeShort(c.executed_at)}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px] text-slate-600 whitespace-nowrap">
                        {formatDateTimeShort(c.submitted_at)}
                        {c.submissions_count > 1 && (
                          <span className="block text-[10px] text-slate-500">
                            v{c.submissions_count} pres.
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-semibold ${meta.surfaceClass} ${meta.textClass}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-sm ${meta.dotClass}`} />
                          {meta.label}
                        </span>
                        {Number(c.attachments_count || 0) === 0 &&
                          ([CountStatus.ENTREGADO, CountStatus.APROBADO] as CountStatus[]).includes(
                            c.status
                          ) && (
                            <span className="block text-[10px] font-semibold text-amber-700 mt-1">
                              Pend. foto firmada de respaldo
                            </span>
                          )}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px] text-slate-600 whitespace-nowrap">
                        {formatDateTimeShort(c.updated_at || c.created_at)}
                      </td>
                      <td className="py-2.5 px-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleOpenDetail(c.id)}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium border border-slate-300 rounded text-slate-700 hover:bg-slate-100"
                          >
                            <Eye className="w-3 h-3" />
                            Detalle
                          </button>

                          {isJefe &&
                            c.status === CountStatus.EJECUCION &&
                            !c.assigned_counter_id && (
                            <button
                              type="button"
                              onClick={() => {
                                setAssignModalCount(c);
                                setAssignCounterId(counters[0] ? String(counters[0].id) : '');
                                setAssignReason('');
                              }}
                              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-sky-700 text-white rounded hover:bg-sky-800"
                            >
                              <UserPlus className="w-3 h-3" />
                              Asignar
                            </button>
                          )}

                          {onOpenExecution &&
                            ([CountStatus.EJECUCION, CountStatus.RECHAZADO] as string[]).includes(
                              c.status
                            ) &&
                            (isContador || isJefe || currentUser.role === UserRole.RESPONSABLE_DEPOSITO) && (
                              <button
                                type="button"
                                onClick={() => onOpenExecution(c.id)}
                                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium border border-slate-300 text-slate-800 rounded hover:bg-slate-100"
                              >
                                <ArrowUpRight className="w-3 h-3" />
                                Ejecutar
                              </button>
                            )}

                          {onOpenValidation &&
                            isJefe &&
                            ([CountStatus.ENTREGADO, CountStatus.APROBADO] as string[]).includes(
                              c.status
                            ) && (
                              <button
                                type="button"
                                onClick={() => onOpenValidation(c.id)}
                                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-[#8e0d0d] text-white rounded hover:bg-[#6e0909]"
                              >
                                <ArrowUpRight className="w-3 h-3" />
                                Auditar
                              </button>
                            )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Assign Counter Modal for unassigned EJECUCION counts */}
      {assignModalCount && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-xs font-mono text-slate-500">
                  {assignModalCount.count_number} · {assignModalCount.location_name}
                </div>
                <h3 className="text-base font-bold text-slate-900">
                  Asignar Responsable de Conteo
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setAssignModalCount(null)}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleAssignSubmit} className="space-y-4 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Responsable de Conteo *
                </label>
                <select
                  required
                  value={assignCounterId}
                  onChange={(e) => setAssignCounterId(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                >
                  <option value="">Seleccionar contador autorizado...</option>
                  {counters.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName} ({u.username})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Nota de asignación (opcional)
                </label>
                <input
                  type="text"
                  value={assignReason}
                  onChange={(e) => setAssignReason(e.target.value)}
                  placeholder="Instrucciones iniciales..."
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setAssignModalCount(null)}
                  className="px-3 py-2 border border-slate-300 rounded-lg text-slate-700"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={assigning || !assignCounterId}
                  className="px-4 py-2 bg-[#8e0d0d] text-white rounded-lg font-medium hover:bg-[#6e0909] disabled:opacity-50"
                >
                  {assigning ? 'Asignando...' : 'Confirmar Asignación'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Detailed Traceability Drawer/Modal */}
      {detailModal && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-slate-200 flex items-start justify-between gap-4 bg-slate-50/70">
              <div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono font-bold text-slate-900">
                    {String(detailModal.count.count_number)}
                  </span>
                  <span className="text-slate-400">·</span>
                  <span className="font-mono text-slate-500">
                    {String(detailModal.count.document_uid)}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] font-semibold ${
                      getCountStatusMeta(String(detailModal.count.status)).surfaceClass
                    } ${getCountStatusMeta(String(detailModal.count.status)).textClass}`}
                  >
                    {getCountStatusMeta(String(detailModal.count.status)).label}
                  </span>
                </div>
                <h3 className="text-lg font-bold text-slate-900 mt-1">
                  {String(detailModal.count.location_name)} ({String(detailModal.count.location_group)})
                </h3>
                <div className="text-xs text-slate-600 mt-0.5">
                  Creado por: {String(detailModal.count.created_by_name || 'Sistema')} · Responsable:{' '}
                  {String(detailModal.count.counter_name || 'Sin asignar')} · Prog.:{' '}
                  <span className="font-mono">{String(detailModal.count.scheduled_date)}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDetailModal(null)}
                className="p-1 text-slate-400 hover:text-slate-700 rounded"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Signatures & Metadata Strip */}
            <div className="px-6 py-3 bg-white border-b border-slate-200 grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
              <div>
                <div className="text-[11px] text-slate-500">Firma Contador</div>
                <div className="font-medium text-slate-900">
                  {String(detailModal.count.counter_signature_name || 'Pendiente')}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-slate-500">Firma Depósito</div>
                <div className="font-medium text-slate-900">
                  {String(detailModal.count.warehouse_signature_name || 'Pendiente')}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-slate-500">Aprobación / Rechazo Jefe</div>
                <div className="font-medium text-slate-900">
                  {detailModal.count.approved_by_name
                    ? `Aprobado por ${String(detailModal.count.approved_by_name)}`
                    : detailModal.count.rejected_by_name
                      ? `Rechazado por ${String(detailModal.count.rejected_by_name)}`
                      : 'Pendiente'}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-slate-500">Estado de Aprobación</div>
                <div className="font-medium text-slate-900">
                  {detailModal.count.approved_at
                    ? `Aprobado (${formatDateTimeShort(detailModal.count.approved_at)})`
                    : 'Pendiente'}
                </div>
              </div>
            </div>

            {Boolean(detailModal.count.rejection_reason) && (
              <div className="mx-6 mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-900">
                <strong>Motivo de rechazo vigente:</strong>{' '}
                {String(detailModal.count.rejection_reason)}
              </div>
            )}

            {Boolean(detailModal.count.counter_general_notes) && (
              <div className="mx-6 mt-3 p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800">
                <strong>Observaciones generales del contador:</strong>{' '}
                {String(detailModal.count.counter_general_notes)}
              </div>
            )}

            {/* Subtabs */}
            <div className="px-6 pt-3 border-b border-slate-200 flex items-center gap-4 text-xs">
              <button
                type="button"
                onClick={() => setDetailTab('items')}
                className={`pb-2.5 font-semibold border-b-2 transition-colors inline-flex items-center gap-1.5 ${
                  detailTab === 'items'
                    ? 'border-[#8e0d0d] text-[#8e0d0d]'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                Artículos y Adjuntos ({detailModal.items.length})
              </button>
              <button
                type="button"
                onClick={() => setDetailTab('history')}
                className={`pb-2.5 font-semibold border-b-2 transition-colors inline-flex items-center gap-1.5 ${
                  detailTab === 'history'
                    ? 'border-[#8e0d0d] text-[#8e0d0d]'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                <History className="w-3.5 h-3.5" />
                Historial de Estados ({detailModal.stateHistory.length})
              </button>
              <button
                type="button"
                onClick={() => setDetailTab('versions')}
                className={`pb-2.5 font-semibold border-b-2 transition-colors inline-flex items-center gap-1.5 ${
                  detailTab === 'versions'
                    ? 'border-[#8e0d0d] text-[#8e0d0d]'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                <ClipboardList className="w-3.5 h-3.5" />
                Versiones Presentadas ({detailModal.submissions.length})
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto flex-1 space-y-4">
              {detailTab === 'items' && (
                <>
                  <div className="overflow-x-auto border border-slate-200 rounded-lg">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
                          <th className="py-2 px-3">Código</th>
                          <th className="py-2 px-3">Descripción</th>
                          {!detailModal.isBlindRestricted && (
                            <th className="py-2 px-3 text-right">ERP Snap.</th>
                          )}
                          <th className="py-2 px-3 text-right">Contado</th>
                          {!detailModal.isBlindRestricted && (
                            <>
                              <th className="py-2 px-3 text-right">Dif.</th>
                              <th className="py-2 px-3">Conciliación</th>
                              <th className="py-2 px-3">Regularización</th>
                            </>
                          )}
                          <th className="py-2 px-3">Obs. / Evidencia</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detailModal.items.map((it) => {
                          const isUncounted = Number(it.is_not_counted || 0) === 1;
                          const atts = (it.attachments || []) as Array<{
                            id: number;
                            original_name: string;
                          }>;
                          return (
                            <tr key={String(it.id)} className="border-b border-slate-100">
                              <td className="py-2 px-3 font-mono font-semibold text-slate-900">
                                {String(it.sku)}
                              </td>
                              <td className="py-2 px-3 text-slate-800">{String(it.description)}</td>
                              {!detailModal.isBlindRestricted && (
                                <td className="py-2 px-3 text-right font-mono tabular-nums">
                                  {String(it.snapshot_erp_stock ?? '—')}
                                </td>
                              )}
                              <td className="py-2 px-3 text-right font-mono tabular-nums">
                                {isUncounted ? (
                                  <span className="text-amber-800 font-semibold">No contado</span>
                                ) : it.final_counted_qty !== null && it.final_counted_qty !== undefined ? (
                                  Number(it.final_counted_qty)
                                ) : (
                                  '—'
                                )}
                              </td>
                              {!detailModal.isBlindRestricted && (
                                <>
                                  <td className="py-2 px-3 text-right font-mono font-semibold tabular-nums">
                                    {it.difference !== null && it.difference !== undefined
                                      ? `${Number(it.difference) > 0 ? '+' : ''}${Number(it.difference)}`
                                      : '—'}
                                  </td>
                                  <td className="py-2 px-3">
                                    {isUncounted
                                      ? 'No contado'
                                      : String(it.reconciliation_result || 'Pendiente')}
                                  </td>
                                  <td className="py-2 px-3">
                                    <div className="font-medium text-slate-800">
                                      {String(it.adjustment_status || 'PENDIENTE')}
                                    </div>
                                    {Boolean(it.erp_operation_number) && (
                                      <div className="text-[11px] font-mono text-slate-500">
                                        {String(it.erp_operation_number)}
                                      </div>
                                    )}
                                  </td>
                                </>
                              )}
                              <td className="py-2 px-3 space-y-1">
                                {isUncounted && (
                                  <div className="text-[11px] text-amber-800">
                                    Motivo: {String(it.not_counted_reason)}
                                  </div>
                                )}
                                {Boolean(it.counter_observations) && (
                                  <div className="text-slate-600">{String(it.counter_observations)}</div>
                                )}
                                {atts.map((att) => (
                                  <button
                                    key={att.id}
                                    type="button"
                                    onClick={() => handleDownloadAttachment(att.id, att.original_name)}
                                    className="inline-flex items-center gap-1 text-[11px] text-blue-700 hover:underline mr-2"
                                  >
                                    <Download className="w-3 h-3" />
                                    {att.original_name}
                                  </button>
                                ))}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Count-Level Attachments */}
                  <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-xs">
                    <div className="font-semibold text-slate-800 mb-2">
                      Documentos Respaldatorios del Conteo ({detailModal.sheetAttachments.length})
                    </div>
                    {detailModal.sheetAttachments.length === 0 ? (
                      <div className="text-slate-500">Sin archivos adjuntos a nivel de planilla/ajuste.</div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {detailModal.sheetAttachments.map((att) => (
                          <button
                            key={att.id}
                            type="button"
                            onClick={() => handleDownloadAttachment(att.id, att.original_name)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white border border-slate-300 rounded text-blue-700 hover:bg-slate-50"
                          >
                            <Paperclip className="w-3 h-3" />
                            <span>{att.original_name}</span>
                            <Download className="w-3 h-3 text-slate-400" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}

              {detailTab === 'history' && (
                <div className="space-y-2.5">
                  {detailModal.stateHistory.length === 0 ? (
                    <div className="text-xs text-slate-500 py-6 text-center">
                      No hay transiciones registradas aún.
                    </div>
                  ) : (
                    detailModal.stateHistory.map((h) => {
                      const prevMeta = h.previous_status ? getCountStatusMeta(h.previous_status) : null;
                      const nextMeta = getCountStatusMeta(h.new_status);
                      return (
                        <div
                          key={h.id}
                          className="p-3 border border-slate-200 rounded-lg bg-white text-xs space-y-1"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              {prevMeta && (
                                <>
                                  <span className="font-medium text-slate-500">{prevMeta.label}</span>
                                  <span className="text-slate-400">→</span>
                                </>
                              )}
                              <span
                                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] font-semibold ${nextMeta.surfaceClass} ${nextMeta.textClass}`}
                              >
                                {nextMeta.label}
                              </span>
                            </div>
                            <span className="font-mono text-[11px] text-slate-500">
                              {formatDateTimeShort(h.created_at)}
                            </span>
                          </div>
                          <div className="text-slate-700">{h.reason || 'Cambio de estado registrado'}</div>
                          <div className="text-[11px] text-slate-500">
                            Usuario: <strong>{h.changed_by_full_name || h.changed_by_username}</strong>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {detailTab === 'versions' && (
                <div className="space-y-3">
                  {detailModal.submissions.length === 0 ? (
                    <div className="text-xs text-slate-500 py-6 text-center">
                      Este conteo aún no ha sido presentado para aprobación.
                    </div>
                  ) : (
                    detailModal.submissions.map((sub) => (
                      <div key={sub.id} className="border border-slate-200 rounded-lg p-4 text-xs space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="font-bold text-slate-900">
                            Presentación Versión #{sub.version_number}
                          </div>
                          <div className="flex items-center gap-2">
                            <span
                              className={`px-2 py-0.5 rounded border text-[11px] font-semibold ${
                                getCountStatusMeta(sub.outcome_status).surfaceClass
                              } ${getCountStatusMeta(sub.outcome_status).textClass}`}
                            >
                              {getCountStatusMeta(sub.outcome_status).label}
                            </span>
                            <span className="font-mono text-[11px] text-slate-500">
                              {formatDateTimeShort(sub.created_at)}
                            </span>
                          </div>
                        </div>
                        <div className="text-slate-700">
                          Presentado por:{' '}
                          <strong>{sub.submitted_by_full_name || sub.submitted_by_username}</strong> · Firma
                          contador: <strong>{sub.counter_signature_name}</strong> · Firma depósito:{' '}
                          <strong>{sub.warehouse_signature_name}</strong>
                        </div>
                        <div className="text-slate-700 bg-slate-50 p-2 rounded border border-slate-200">
                          <strong>Observaciones generales:</strong> {sub.general_observations}
                        </div>
                        {sub.review_notes && (
                          <div className="text-slate-700 bg-amber-50/70 p-2 rounded border border-amber-200">
                            <strong>Resolución Jefe ({sub.reviewed_by_full_name || 'Control Stock'}):</strong>{' '}
                            {sub.review_notes}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
