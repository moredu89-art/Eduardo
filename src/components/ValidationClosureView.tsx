import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileCheck2,
  History,
  Lock,
  Paperclip,
  ShieldCheck,
  ThumbsUp,
  X,
  XCircle,
} from 'lucide-react';
import { apiFetch, getAuthToken } from '../lib/api';
import { getCountStatusMeta } from '../lib/countStatus';
import { AdjustmentOperationType, AuthUser, CountStatus } from '../types/erp';

interface CountSummary {
  id: number;
  count_number: string;
  location_name: string;
  scheduled_date: string;
  counter_name: string;
  status: CountStatus;
  items_count: number;
  discrepancies_count: number;
  not_counted_items_count?: number;
  submitted_at?: string | null;
  counter_signature_name: string;
  warehouse_signature_name: string;
  chief_signature_name: string;
}

interface SubmissionRecord {
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
}

interface ValidationClosureViewProps {
  currentUser: AuthUser;
  initialCountId?: number | null;
}

export const ValidationClosureView: React.FC<ValidationClosureViewProps> = ({
  currentUser,
  initialCountId = null,
}) => {
  const [counts, setCounts] = useState<CountSummary[]>([]);
  const [filterStatus, setFilterStatus] = useState<string>('PENDIENTE_APROBACION');
  const [selectedId, setSelectedId] = useState<number | null>(initialCountId);
  const [detail, setDetail] = useState<{
    count: Record<string, unknown>;
    items: Array<Record<string, unknown>>;
    postSnapshotMovements: Array<Record<string, unknown>>;
    sheetAttachments: Array<{ id: number; original_name: string }>;
    submissions: SubmissionRecord[];
  } | null>(null);

  const [chiefNotes, setChiefNotes] = useState('');
  const [chiefSig, setChiefSig] = useState(currentUser.fullName);
  const [recountReasons, setRecountReasons] = useState<Record<number, string>>({});

  // In-app confirmation & rejection modals (iframe-safe, never window.confirm)
  const [approveModalOpen, setApproveModalOpen] = useState(false);
  const [approvalNotesInput, setApprovalNotesInput] = useState('');
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectionReasonInput, setRejectionReasonInput] = useState('');
  const [closeModalOpen, setCloseModalOpen] = useState(false);

  const [regTarget, setRegTarget] = useState<Record<string, unknown> | null>(null);
  const [regForm, setRegForm] = useState({
    adjustmentStatus: AdjustmentOperationType.AJUSTE as AdjustmentOperationType,
    erpOperationNumber: '',
    regularizationDate: new Date().toISOString().slice(0, 10),
    noAdjustmentReason: '',
    adjustmentNotes: '',
  });

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openDetail = async (id: number) => {
    setSelectedId(id);
    setError(null);
    try {
      const res = await apiFetch<{
        count: Record<string, unknown>;
        items: Array<Record<string, unknown>>;
        postSnapshotMovements: Array<Record<string, unknown>>;
        sheetAttachments?: Array<{ id: number; original_name: string }>;
        submissions?: SubmissionRecord[];
      }>(`/api/counts/${id}`);
      setDetail({
        count: res.count,
        items: res.items,
        postSnapshotMovements: res.postSnapshotMovements || [],
        sheetAttachments: res.sheetAttachments || [],
        submissions: res.submissions || [],
      });
      setChiefNotes(String(res.count.approval_notes || res.count.chief_notes || ''));
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const loadCounts = async (targetOpenId?: number | null) => {
    setLoading(true);
    try {
      const res = await apiFetch<{ counts: CountSummary[] }>('/api/counts');
      setCounts(res.counts);
      const idToOpen = targetOpenId ?? selectedId;
      if (idToOpen) {
        const matched = res.counts.find((c) => c.id === idToOpen);
        if (matched && targetOpenId) {
          if (matched.status === CountStatus.PENDIENTE_APROBACION) {
            setFilterStatus('PENDIENTE_APROBACION');
          } else if (
            matched.status === CountStatus.APROBADO ||
            matched.status === CountStatus.PENDIENTE_REGULARIZACION
          ) {
            setFilterStatus('REGULARIZACION');
          } else if (matched.status === CountStatus.RECHAZADO) {
            setFilterStatus('RECHAZADOS');
          } else if (matched.status === CountStatus.CERRADO) {
            setFilterStatus('CERRADOS');
          } else {
            setFilterStatus('ALL');
          }
        }
        await openDetail(idToOpen);
      }
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCounts(initialCountId);
  }, [initialCountId]);

  const handleConfirmApprove = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    setError(null);
    setMessage(null);
    setSubmitting(true);
    try {
      await apiFetch(`/api/counts/${detail.count.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ approvalNotes: approvalNotesInput.trim() || chiefNotes.trim() }),
      });
      setApproveModalOpen(false);
      setApprovalNotesInput('');
      setMessage(
        'Conteo aprobado por Control de Stock sin modificar el stock ERP. Ahora puede regularizar novedades o finalizar el cierre.'
      );
      await loadCounts(Number(detail.count.id));
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmReject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    const reason = rejectionReasonInput.trim();
    if (!reason) {
      setError('El motivo de rechazo es obligatorio.');
      return;
    }
    setError(null);
    setMessage(null);
    setSubmitting(true);
    try {
      const itemReasons = Object.entries(recountReasons)
        .filter(([, r]) => r.trim() !== '')
        .map(([itemId, itemReason]) => ({ itemId: Number(itemId), reason: itemReason.trim() }));

      await apiFetch(`/api/counts/${detail.count.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({
          rejectionReason: reason,
          itemReasons,
          chiefObservations: reason,
        }),
      });
      setRejectModalOpen(false);
      setRejectionReasonInput('');
      setMessage(
        'Conteo rechazado y devuelto al contador asignado. Se conservó la versión original en el historial.'
      );
      await loadCounts(Number(detail.count.id));
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleStartRegularization = async () => {
    if (!detail) return;
    setError(null);
    setMessage(null);
    setSubmitting(true);
    try {
      await apiFetch(`/api/counts/${detail.count.id}/start-regularization`, { method: 'POST' });
      setMessage('Estado actualizado a Pendiente de Regularización.');
      await loadCounts(Number(detail.count.id));
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveRegularization = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail || !regTarget) return;
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch(`/api/counts/${detail.count.id}/items/${regTarget.id}/regularize`, {
        method: 'POST',
        body: JSON.stringify(regForm),
      });
      setRegTarget(null);
      setMessage('Regularización registrada con trazabilidad.');
      await loadCounts(Number(detail.count.id));
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmCloseCount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    setError(null);
    setMessage(null);
    setSubmitting(true);
    try {
      await apiFetch(`/api/counts/${detail.count.id}/close`, {
        method: 'POST',
        body: JSON.stringify({ chiefSignatureName: chiefSig.trim() }),
      });
      setCloseModalOpen(false);
      setMessage('Conteo cerrado y finalizado permanentemente con firma del Jefe de Control de Stock.');
      await loadCounts(Number(detail.count.id));
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleUploadVoucher = async (file: File) => {
    if (!detail) return;
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('entityType', 'ADJUSTMENT');
      fd.append('entityId', String(detail.count.id));
      const token = getAuthToken();
      const res = await fetch('/api/attachments', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error subiendo comprobante');
      setMessage(`Comprobante ERP "${data.original_name}" adjuntado.`);
      await openDetail(Number(detail.count.id));
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const handleDownloadAttachment = async (attId: number, originalName: string) => {
    setError(null);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/attachments/${attId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'No se pudo descargar el archivo');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = originalName || `adjunto-${attId}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const filteredCounts = counts.filter((c) => {
    if (filterStatus === 'PENDIENTE_APROBACION') {
      return c.status === CountStatus.PENDIENTE_APROBACION;
    }
    if (filterStatus === 'REGULARIZACION') {
      return (
        c.status === CountStatus.APROBADO ||
        c.status === CountStatus.PENDIENTE_REGULARIZACION
      );
    }
    if (filterStatus === 'RECHAZADOS') {
      return c.status === CountStatus.RECHAZADO;
    }
    if (filterStatus === 'CERRADOS') {
      return c.status === CountStatus.CERRADO;
    }
    return true;
  });

  const pendingApprovalCount = counts.filter(
    (c) => c.status === CountStatus.PENDIENTE_APROBACION
  ).length;
  const regCount = counts.filter(
    (c) =>
      c.status === CountStatus.APROBADO ||
      c.status === CountStatus.PENDIENTE_REGULARIZACION
  ).length;

  const statusStr = detail ? String(detail.count.status) : '';
  const isClosed = statusStr === CountStatus.CERRADO;
  const isPendingApproval = statusStr === CountStatus.PENDIENTE_APROBACION;
  const isApprovedOrReg =
    statusStr === CountStatus.APROBADO ||
    statusStr === CountStatus.PENDIENTE_REGULARIZACION;

  const detailMeta = detail ? getCountStatusMeta(statusStr) : null;

  // Compute summary metrics for selected count
  const reviewSummary = detail
    ? detail.items.reduce<{
        matches: number;
        shortages: number;
        surpluses: number;
        notCounted: number;
        pendingRegularization: number;
        netDiff: number;
      }>(
        (acc, it) => {
          const isNc = Number(it.is_not_counted || 0) === 1;
          if (isNc) {
            acc.notCounted += 1;
            if (it.adjustment_status === AdjustmentOperationType.PENDIENTE) {
              acc.pendingRegularization += 1;
            }
            return acc;
          }
          if (it.reconciliation_result === 'COINCIDENCIA') acc.matches += 1;
          else if (it.reconciliation_result === 'FALTANTE') {
            acc.shortages += 1;
            if (it.adjustment_status === AdjustmentOperationType.PENDIENTE) {
              acc.pendingRegularization += 1;
            }
          } else if (it.reconciliation_result === 'SOBRANTE') {
            acc.surpluses += 1;
            if (it.adjustment_status === AdjustmentOperationType.PENDIENTE) {
              acc.pendingRegularization += 1;
            }
          }
          acc.netDiff += Number(it.difference || 0);
          return acc;
        },
        {
          matches: 0,
          shortages: 0,
          surpluses: 0,
          notCounted: 0,
          pendingRegularization: 0,
          netDiff: 0,
        }
      )
    : null;

  const totalDetailAttachments = detail
    ? detail.sheetAttachments.length +
      detail.items.reduce(
        (acc, it) => acc + (Array.isArray(it.attachments) ? it.attachments.length : 0),
        0
      )
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">
            Aprobación, Regularización y Cierre de Conteos
          </h2>
          <p className="text-sm text-slate-600 mt-0.5">
            Bandeja ejecutiva del Jefe de Control de Stock. Apruebe o rechace conteos presentados, documente ajustes en ERP y ejecute el cierre definitivo.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
          {[
            ['PENDIENTE_APROBACION', `Pend. Aprobación (${pendingApprovalCount})`],
            ['REGULARIZACION', `Aprobados / Reg. (${regCount})`],
            ['RECHAZADOS', 'Rechazados'],
            ['CERRADOS', 'Cerrados'],
            ['ALL', 'Todos'],
          ].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setFilterStatus(k)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                filterStatus === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 text-xs font-bold text-slate-900">
            Conteos en Bandeja ({filteredCounts.length})
          </div>
          {loading ? (
            <div className="p-6 text-xs text-slate-500 text-center">Cargando...</div>
          ) : filteredCounts.length === 0 ? (
            <div className="p-6 text-xs text-slate-500 text-center">
              No hay conteos en esta bandeja.
            </div>
          ) : (
            <div className="divide-y divide-slate-100 max-h-[660px] overflow-y-auto">
              {filteredCounts.map((c) => {
                const meta = getCountStatusMeta(c.status);
                return (
                  <button
                    key={c.id}
                    onClick={() => openDetail(c.id)}
                    className={`w-full text-left p-3.5 hover:bg-slate-50 ${
                      selectedId === c.id ? 'bg-blue-50/70' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-mono font-bold text-slate-900">{c.count_number}</span>
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium border rounded ${meta.surfaceClass} ${meta.textClass}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${meta.dotClass}`} />
                        {meta.shortLabel}
                      </span>
                    </div>
                    <div className="text-xs font-medium text-slate-800 mt-1">{c.location_name}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                      {c.scheduled_date} · {c.counter_name || 'Sin asignar'} ·{' '}
                      <span className={c.discrepancies_count > 0 ? 'text-red-700 font-semibold' : ''}>
                        {c.discrepancies_count} dif.
                      </span>
                      {(c.not_counted_items_count || 0) > 0 && (
                        <span className="text-amber-700 font-semibold">
                          {' '}
                          · {c.not_counted_items_count} N/C
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5 space-y-5">
          {!detail ? (
            <div className="py-16 text-center text-sm text-slate-500">
              <FileCheck2 className="w-8 h-8 text-slate-400 mx-auto mb-2" />
              Seleccione un conteo para auditar los resultados presentados, aprobar o rechazar, documentar ajustes ERP y finalizar el cierre.
            </div>
          ) : (
            <>
              {/* Header */}
              <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-200">
                <div>
                  <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-slate-500">
                    <span>{String(detail.count.count_number)}</span>
                    {detailMeta && (
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 font-sans text-[11px] font-medium border rounded ${detailMeta.surfaceClass} ${detailMeta.textClass}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${detailMeta.dotClass}`} />
                        {detailMeta.label}
                      </span>
                    )}
                  </div>
                  <h3 className="text-lg font-bold text-slate-900 mt-1">
                    {String(detail.count.location_name)}
                  </h3>
                  <div className="text-xs text-slate-600 mt-0.5">
                    Contador: {String(detail.count.counter_name || 'Sin asignar')} · Firma Contador:{' '}
                    {String(detail.count.counter_signature_name || 'Pendiente')} · Firma Depósito:{' '}
                    {String(detail.count.warehouse_signature_name || 'Pendiente')}
                  </div>
                  {Boolean(detail.count.submitted_at) && (
                    <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                      Presentado: {String(detail.count.submitted_at).replace('T', ' ').slice(0, 16)}
                      {detail.count.approved_at
                        ? ` · Aprobado: ${String(detail.count.approved_at).replace('T', ' ').slice(0, 16)}`
                        : ''}
                    </div>
                  )}
                </div>

                {isClosed && (
                  <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                    <Lock className="w-4 h-4" />
                    Cerrado Definitivamente ({String(detail.count.closed_at).slice(0, 16)})
                  </div>
                )}
              </div>

              {/* Review KPI Strip */}
              {reviewSummary && (
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-xs">
                  <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                    <div className="text-[11px] text-slate-500">Artículos</div>
                    <div className="text-base font-mono font-bold text-slate-900 tabular-nums">
                      {detail.items.length}
                    </div>
                  </div>
                  <div className="p-2.5 bg-emerald-50/70 border border-emerald-200 rounded-lg">
                    <div className="text-[11px] text-emerald-700">Coincidencias</div>
                    <div className="text-base font-mono font-bold text-emerald-800 tabular-nums">
                      {reviewSummary.matches}
                    </div>
                  </div>
                  <div className="p-2.5 bg-red-50/70 border border-red-200 rounded-lg">
                    <div className="text-[11px] text-red-700">Faltantes</div>
                    <div className="text-base font-mono font-bold text-red-800 tabular-nums">
                      {reviewSummary.shortages}
                    </div>
                  </div>
                  <div className="p-2.5 bg-amber-50/70 border border-amber-200 rounded-lg">
                    <div className="text-[11px] text-amber-800">Sobrantes</div>
                    <div className="text-base font-mono font-bold text-amber-900 tabular-nums">
                      {reviewSummary.surpluses}
                    </div>
                  </div>
                  <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                    <div className="text-[11px] text-slate-600">No Contados</div>
                    <div className="text-base font-mono font-bold text-slate-900 tabular-nums">
                      {reviewSummary.notCounted}
                    </div>
                  </div>
                </div>
              )}

              {/* Counter General Notes & Rejection History */}
              {String(detail.count.counter_general_notes || '').trim() !== '' && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700">
                  <span className="font-semibold text-slate-900">
                    Observaciones generales del contador:
                  </span>{' '}
                  {String(detail.count.counter_general_notes)}
                </div>
              )}

              {statusStr === CountStatus.RECHAZADO &&
                String(detail.count.rejection_reason || '').trim() !== '' && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-900">
                    <strong>Motivo del rechazo vigente:</strong>{' '}
                    {String(detail.count.rejection_reason)}
                  </div>
                )}

              {detail.postSnapshotMovements.length > 0 && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 space-y-1">
                  <div className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4" />
                    Movimientos posteriores a la fotografía teórica ({detail.postSnapshotMovements.length})
                  </div>
                  {detail.postSnapshotMovements.slice(0, 5).map((m) => (
                    <div key={String(m.id)} className="text-[11px] font-mono">
                      {String(m.created_at)} · {String(m.sku)} · {String(m.movement_type)} (
                      {Number(m.quantity_delta) > 0 ? `+${m.quantity_delta}` : Number(m.quantity_delta)})
                    </div>
                  ))}
                </div>
              )}

              {/* Reconciliation & Regularization Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
                      <th className="py-2 px-2.5">Código / Artículo</th>
                      <th className="py-2 px-2.5 text-right">ERP</th>
                      <th className="py-2 px-2.5 text-right">R1</th>
                      <th className="py-2 px-2.5 text-right">R2</th>
                      <th className="py-2 px-2.5 text-right">Dif. Final</th>
                      <th className="py-2 px-2.5">Regularización ERP</th>
                      {!isClosed && (isPendingApproval || isApprovedOrReg) && (
                        <th className="py-2 px-2.5">Acción</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {detail.items.map((it) => {
                      const isNotCounted = Number(it.is_not_counted || 0) === 1;
                      const hasDiff =
                        it.reconciliation_result === 'FALTANTE' ||
                        it.reconciliation_result === 'SOBRANTE';
                      const needsReg = isNotCounted || hasDiff;
                      const itemAtts = Array.isArray(it.attachments)
                        ? (it.attachments as Array<{ id: number; original_name: string }>)
                        : [];

                      return (
                        <React.Fragment key={String(it.id)}>
                          <tr className="border-b border-slate-100">
                            <td className="py-2 px-2.5 align-top">
                              <div className="font-mono font-semibold text-slate-900">
                                {String(it.sku)}
                              </div>
                              <div className="text-slate-700">{String(it.description)}</div>
                              {isNotCounted && (
                                <div className="text-[11px] text-amber-800 font-medium mt-0.5">
                                  No contado: {String(it.not_counted_reason || 'Sin motivo')}
                                </div>
                              )}
                              {Boolean(it.counter_observations) && (
                                <div className="text-[11px] text-slate-500 mt-0.5">
                                  Obs: {String(it.counter_observations)}
                                </div>
                              )}
                              {itemAtts.length > 0 && (
                                <div className="flex flex-wrap gap-2 mt-1">
                                  {itemAtts.map((att) => (
                                    <button
                                      key={att.id}
                                      type="button"
                                      onClick={() =>
                                        handleDownloadAttachment(att.id, att.original_name)
                                      }
                                      className="inline-flex items-center gap-1 text-[11px] text-blue-700 hover:underline"
                                    >
                                      <Download className="w-3 h-3" />
                                      {att.original_name}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td className="py-2 px-2.5 text-right font-mono tabular-nums align-top">
                              {Number(it.snapshot_erp_stock)}
                            </td>
                            <td className="py-2 px-2.5 text-right font-mono tabular-nums align-top">
                              {isNotCounted ? (
                                <span className="text-[11px] text-amber-800">N/C</span>
                              ) : (
                                <>
                                  <div>{it.counted_qty !== null ? Number(it.counted_qty) : '—'}</div>
                                  {it.bulk_qty !== null &&
                                    it.bulk_qty !== undefined &&
                                    it.loose_qty !== null &&
                                    it.loose_qty !== undefined && (
                                      <div className="text-[10px] text-slate-500">
                                        {Number(it.bulk_qty)} B + {Number(it.loose_qty)} S
                                      </div>
                                    )}
                                </>
                              )}
                            </td>
                            <td className="py-2 px-2.5 text-right font-mono tabular-nums text-blue-700 align-top">
                              <div>{it.recount_qty !== null ? Number(it.recount_qty) : '—'}</div>
                              {it.recount_bulk_qty !== null &&
                                it.recount_bulk_qty !== undefined &&
                                it.recount_loose_qty !== null &&
                                it.recount_loose_qty !== undefined && (
                                  <div className="text-[10px] text-blue-500">
                                    {Number(it.recount_bulk_qty)} B + {Number(it.recount_loose_qty)} S
                                  </div>
                                )}
                            </td>
                            <td
                              className={`py-2 px-2.5 text-right font-mono font-bold tabular-nums align-top ${
                                isNotCounted
                                  ? 'text-amber-800'
                                  : Number(it.difference || 0) < 0
                                    ? 'text-red-700'
                                    : Number(it.difference || 0) > 0
                                      ? 'text-amber-700'
                                      : 'text-emerald-700'
                              }`}
                            >
                              {isNotCounted
                                ? 'N/C'
                                : it.difference !== null
                                  ? `${Number(it.difference) > 0 ? '+' : ''}${Number(it.difference)}`
                                  : '—'}
                            </td>
                            <td className="py-2 px-2.5 align-top">
                              {!needsReg ? (
                                <span className="text-emerald-700">Coincidencia</span>
                              ) : (
                                <div>
                                  <div
                                    className={`font-semibold ${
                                      it.adjustment_status === AdjustmentOperationType.PENDIENTE
                                        ? 'text-orange-700'
                                        : 'text-slate-900'
                                    }`}
                                  >
                                    {String(it.adjustment_status)}
                                  </div>
                                  {Boolean(it.erp_operation_number) && (
                                    <div className="font-mono text-[11px] text-slate-600">
                                      ERP: {String(it.erp_operation_number)}
                                    </div>
                                  )}
                                  {Boolean(it.no_adjustment_reason) && (
                                    <div className="text-[11px] text-slate-600">
                                      Motivo: {String(it.no_adjustment_reason)}
                                    </div>
                                  )}
                                </div>
                              )}
                            </td>
                            {!isClosed && (isPendingApproval || isApprovedOrReg) && (
                              <td className="py-2 px-2.5 space-y-1 align-top">
                                {isApprovedOrReg && needsReg && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setRegTarget(it);
                                      setRegForm({
                                        adjustmentStatus:
                                          (it.adjustment_status as AdjustmentOperationType) ===
                                          AdjustmentOperationType.PENDIENTE
                                            ? AdjustmentOperationType.AJUSTE
                                            : (it.adjustment_status as AdjustmentOperationType),
                                        erpOperationNumber: String(it.erp_operation_number || ''),
                                        regularizationDate: String(
                                          it.regularization_date ||
                                            new Date().toISOString().slice(0, 10)
                                        ),
                                        noAdjustmentReason: String(it.no_adjustment_reason || ''),
                                        adjustmentNotes: String(it.adjustment_notes || ''),
                                      });
                                    }}
                                    className="text-blue-700 hover:underline font-medium block whitespace-nowrap"
                                  >
                                    Regularizar
                                  </button>
                                )}
                                {isPendingApproval && (
                                  <input
                                    type="text"
                                    placeholder="Obs. rechazo ítem..."
                                    value={recountReasons[Number(it.id)] || ''}
                                    onChange={(e) =>
                                      setRecountReasons({
                                        ...recountReasons,
                                        [Number(it.id)]: e.target.value,
                                      })
                                    }
                                    className="w-36 px-1.5 py-0.5 text-[11px] border border-slate-300 rounded"
                                  />
                                )}
                              </td>
                            )}
                          </tr>
                          {Boolean(it.historical_alert_text) && hasDiff && (
                            <tr className="bg-red-50/50 border-b border-red-100">
                              <td colSpan={7} className="px-3 py-1.5 text-[11px] text-red-800">
                                {String(it.historical_alert_text)}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Submitted Versions History */}
              {detail.submissions.length > 0 && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2 text-xs">
                  <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                    <History className="w-3.5 h-3.5 text-slate-600" />
                    Versiones Presentadas ({detail.submissions.length})
                  </div>
                  <div className="space-y-1.5">
                    {detail.submissions.map((sub) => (
                      <div
                        key={sub.id}
                        className="flex flex-wrap items-center justify-between gap-2 bg-white border border-slate-200 rounded px-2.5 py-1.5 text-[11px]"
                      >
                        <div>
                          <span className="font-mono font-bold text-slate-900">
                            v{sub.version_number}
                          </span>{' '}
                          · {sub.created_at.replace('T', ' ').slice(0, 16)} ·{' '}
                          <span className="text-slate-600">{sub.general_observations || 'Sin obs.'}</span>
                          {sub.review_notes && (
                            <span className="block text-slate-500">
                              Resolución ({sub.outcome_status}): {sub.review_notes}
                            </span>
                          )}
                        </div>
                        <span className="font-semibold text-slate-800">{sub.outcome_status}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Evidence Attachments */}
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-slate-800">
                    Documentación Respaldatoria ({totalDetailAttachments}):
                  </span>
                  {detail.sheetAttachments.length === 0 ? (
                    <span className="text-slate-500">Sin planilla ni comprobante a nivel conteo</span>
                  ) : (
                    detail.sheetAttachments.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => handleDownloadAttachment(a.id, a.original_name)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 bg-white border border-slate-200 rounded text-blue-700 font-medium hover:underline"
                      >
                        <Download className="w-3 h-3" />
                        {a.original_name}
                      </button>
                    ))
                  )}
                </div>
                {!isClosed && (
                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-300 rounded-lg cursor-pointer hover:bg-slate-50 font-medium whitespace-nowrap">
                    <Paperclip className="w-3.5 h-3.5" />
                    Adjuntar Comprobante ERP
                    <input
                      type="file"
                      accept="image/*,.pdf"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleUploadVoucher(f);
                      }}
                      className="hidden"
                    />
                  </label>
                )}
              </div>

              {/* Stage Controls: 1. PENDIENTE_APROBACION -> Approve / Reject */}
              {isPendingApproval && (
                <div className="pt-4 border-t border-slate-200 space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Observaciones de Auditoría del Jefe de Control de Stock
                    </label>
                    <input
                      type="text"
                      value={chiefNotes}
                      onChange={(e) => setChiefNotes(e.target.value)}
                      placeholder="Notas para aprobación o instrucciones generales..."
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setRejectionReasonInput(chiefNotes);
                        setRejectModalOpen(true);
                      }}
                      disabled={submitting}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-red-800 bg-red-50 border border-red-300 rounded-lg hover:bg-red-100 whitespace-nowrap"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      RECHAZAR CONTEO
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setApprovalNotesInput(chiefNotes);
                        setApproveModalOpen(true);
                      }}
                      disabled={submitting}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-emerald-700 text-white rounded-lg hover:bg-emerald-800 whitespace-nowrap"
                    >
                      <ThumbsUp className="w-3.5 h-3.5" />
                      APROBAR CONTEO
                    </button>
                  </div>
                </div>
              )}

              {/* Stage Controls: 2. APROBADO / PENDIENTE_REGULARIZACION -> Regularize & Close */}
              {isApprovedOrReg && (
                <div className="pt-4 border-t border-slate-200 space-y-4">
                  {reviewSummary && reviewSummary.pendingRegularization > 0 && (
                    <div className="p-3 bg-orange-50 border border-orange-200 rounded-lg text-xs text-orange-900 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <strong>Regularización requerida:</strong> Hay{' '}
                        <span className="font-mono font-bold">
                          {reviewSummary.pendingRegularization}
                        </span>{' '}
                        artículo(s) con diferencia o no contados que deben documentarse como{' '}
                        <strong>AJUSTE</strong>, <strong>MOVIMIENTO</strong> o{' '}
                        <strong>SIN AJUSTE</strong> antes del cierre definitivo.
                      </div>
                      {statusStr === CountStatus.APROBADO && (
                        <button
                          type="button"
                          onClick={handleStartRegularization}
                          disabled={submitting}
                          className="px-3 py-1 text-[11px] font-medium bg-orange-700 text-white rounded hover:bg-orange-800 whitespace-nowrap"
                        >
                          Pasar a Pend. Regularización
                        </button>
                      )}
                    </div>
                  )}

                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div className="w-full sm:w-72">
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Firma Final Jefe de Control de Stock (para cierre)
                      </label>
                      <input
                        type="text"
                        value={chiefSig}
                        onChange={(e) => setChiefSig(e.target.value)}
                        className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={() => setCloseModalOpen(true)}
                      disabled={
                        submitting ||
                        !chiefSig.trim() ||
                        (reviewSummary?.pendingRegularization || 0) > 0 ||
                        totalDetailAttachments === 0
                      }
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                    >
                      <Lock className="w-3.5 h-3.5" />
                      CERRAR Y FINALIZAR CONTEO
                    </button>
                  </div>
                </div>
              )}

              {/* Read-only info when count is BORRADOR / ASIGNADO / EN_EJECUCION / RECHAZADO */}
              {!isClosed && !isPendingApproval && !isApprovedOrReg && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-slate-500 shrink-0" />
                  <span>
                    Este conteo se encuentra en etapa{' '}
                    <strong>{detailMeta?.label}</strong>. Las acciones de aprobación, regularización y cierre se habilitan únicamente cuando el contador presenta los resultados para revisión.
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Approve Confirmation Modal */}
      {approveModalOpen && detail && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-base font-bold text-slate-900">
                Confirmar Aprobación de Conteo
              </h3>
              <button
                type="button"
                onClick={() => setApproveModalOpen(false)}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-600 mb-4">
              Está por aprobar el resultado físico de{' '}
              <span className="font-mono font-bold text-slate-900">
                {String(detail.count.count_number)}
              </span>{' '}
              ({String(detail.count.location_name)}). Esta acción valida el relevamiento sin alterar automáticamente el stock oficial del ERP.
            </p>
            <form onSubmit={handleConfirmApprove} className="space-y-4 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Observaciones de Aprobación (opcional)
                </label>
                <textarea
                  rows={3}
                  value={approvalNotesInput}
                  onChange={(e) => setApprovalNotesInput(e.target.value)}
                  placeholder="Comentarios del Jefe de Control de Stock..."
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setApproveModalOpen(false)}
                  className="px-4 py-2 border border-slate-300 rounded-lg"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 bg-emerald-700 text-white rounded-lg font-semibold hover:bg-emerald-800"
                >
                  {submitting ? 'Aprobando...' : 'Confirmar Aprobación'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reject Modal */}
      {rejectModalOpen && detail && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-base font-bold text-slate-900">
                Rechazar Conteo y Solicitar Corrección
              </h3>
              <button
                type="button"
                onClick={() => setRejectModalOpen(false)}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-600 mb-4">
              El conteo{' '}
              <span className="font-mono font-bold text-slate-900">
                {String(detail.count.count_number)}
              </span>{' '}
              volverá al contador conservando la versión originalmente presentada en el historial.
            </p>
            <form onSubmit={handleConfirmReject} className="space-y-4 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Motivo Obligatorio del Rechazo *
                </label>
                <textarea
                  required
                  rows={3}
                  value={rejectionReasonInput}
                  onChange={(e) => setRejectionReasonInput(e.target.value)}
                  placeholder="Explique qué debe corregir o recontar el responsable asignado..."
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setRejectModalOpen(false)}
                  className="px-4 py-2 border border-slate-300 rounded-lg"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 bg-red-700 text-white rounded-lg font-semibold hover:bg-red-800"
                >
                  {submitting ? 'Rechazando...' : 'Confirmar Rechazo'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Close Confirmation Modal */}
      {closeModalOpen && detail && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-base font-bold text-slate-900">
                Cerrar y Finalizar Conteo Definitivamente
              </h3>
              <button
                type="button"
                onClick={() => setCloseModalOpen(false)}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-600 mb-4">
              Esta acción bloqueará permanentemente el conteo{' '}
              <span className="font-mono font-bold text-slate-900">
                {String(detail.count.count_number)}
              </span>{' '}
              y aplicará en el balance de stock los ajustes/movimientos ERP documentados. Firma:{' '}
              <strong>{chiefSig}</strong>.
            </p>
            <form onSubmit={handleConfirmCloseCount} className="flex justify-end gap-2 text-xs">
              <button
                type="button"
                onClick={() => setCloseModalOpen(false)}
                className="px-4 py-2 border border-slate-300 rounded-lg"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 bg-slate-900 text-white rounded-lg font-semibold hover:bg-slate-800"
              >
                {submitting ? 'Cerrando...' : 'Cerrar y Finalizar Conteo'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Regularization Modal */}
      {regTarget && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6">
            <h3 className="text-base font-bold text-slate-900 mb-1">
              Regularización de Novedad / Diferencia
            </h3>
            <p className="text-xs text-slate-500 mb-4">
              {String(regTarget.sku)} · {String(regTarget.description)} (
              {Number(regTarget.is_not_counted || 0) === 1
                ? 'No contado'
                : `Dif: ${Number(regTarget.difference)}`}
              )
            </p>
            <form onSubmit={handleSaveRegularization} className="space-y-4 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Tipo de Operación</label>
                <select
                  value={regForm.adjustmentStatus}
                  onChange={(e) =>
                    setRegForm({
                      ...regForm,
                      adjustmentStatus: e.target.value as AdjustmentOperationType,
                    })
                  }
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                >
                  <option value={AdjustmentOperationType.AJUSTE}>Ajuste en ERP</option>
                  <option value={AdjustmentOperationType.MOVIMIENTO}>
                    Movimiento entre Depósitos ERP
                  </option>
                  <option value={AdjustmentOperationType.SIN_AJUSTE}>
                    Sin ajuste (Justificado)
                  </option>
                </select>
              </div>

              {regForm.adjustmentStatus !== AdjustmentOperationType.SIN_AJUSTE ? (
                <>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">
                      Nro. de Ajuste o Movimiento en ERP *
                    </label>
                    <input
                      type="text"
                      required
                      value={regForm.erpOperationNumber}
                      onChange={(e) =>
                        setRegForm({ ...regForm, erpOperationNumber: e.target.value })
                      }
                      placeholder="Ej. AJ-00014582"
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">
                      Fecha de Regularización
                    </label>
                    <input
                      type="date"
                      value={regForm.regularizationDate}
                      onChange={(e) =>
                        setRegForm({ ...regForm, regularizationDate: e.target.value })
                      }
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg font-mono"
                    />
                  </div>
                </>
              ) : (
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    Motivo Expreso de "Sin Ajuste" *
                  </label>
                  <textarea
                    required
                    rows={3}
                    value={regForm.noAdjustmentReason}
                    onChange={(e) =>
                      setRegForm({ ...regForm, noAdjustmentReason: e.target.value })
                    }
                    placeholder="Explique la razón auditada por la cual no se realiza ajuste..."
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                  />
                </div>
              )}

              <div>
                <label className="block font-medium text-slate-700 mb-1">Observaciones</label>
                <input
                  type="text"
                  value={regForm.adjustmentNotes}
                  onChange={(e) => setRegForm({ ...regForm, adjustmentNotes: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setRegTarget(null)}
                  className="px-4 py-2 border border-slate-300 rounded-lg"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 bg-slate-900 text-white rounded-lg font-medium"
                >
                  Guardar Regularización
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
