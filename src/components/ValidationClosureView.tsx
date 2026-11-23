import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  Lock,
  Paperclip,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import { apiFetch, getAuthToken } from '../lib/api';
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
  counter_signature_name: string;
  warehouse_signature_name: string;
  chief_signature_name: string;
}

export const ValidationClosureView: React.FC<{ currentUser: AuthUser }> = ({ currentUser }) => {
  const [counts, setCounts] = useState<CountSummary[]>([]);
  const [filterStatus, setFilterStatus] = useState<string>('PENDING');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<{
    count: Record<string, unknown>;
    items: Array<Record<string, unknown>>;
    postSnapshotMovements: Array<Record<string, unknown>>;
    sheetAttachments: Array<{ id: number; original_name: string }>;
  } | null>(null);

  const [chiefNotes, setChiefNotes] = useState('');
  const [chiefSig, setChiefSig] = useState(currentUser.fullName);
  const [recountReasons, setRecountReasons] = useState<Record<number, string>>({});
  const [regTarget, setRegTarget] = useState<Record<string, unknown> | null>(null);
  const [regForm, setRegForm] = useState({
    adjustmentStatus: AdjustmentOperationType.AJUSTE,
    erpOperationNumber: '',
    regularizationDate: new Date().toISOString().slice(0, 10),
    noAdjustmentReason: '',
    adjustmentNotes: '',
  });

  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadCounts = async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ counts: CountSummary[] }>('/api/counts');
      setCounts(res.counts);
      if (selectedId) await openDetail(selectedId);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCounts();
  }, []);

  const openDetail = async (id: number) => {
    setSelectedId(id);
    setError(null);
    try {
      const res = await apiFetch<NonNullable<typeof detail>>(`/api/counts/${id}`);
      setDetail(res);
      setChiefNotes(String(res.count.chief_notes || ''));
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const handleValidate = async () => {
    if (!detail) return;
    setError(null);
    setMessage(null);
    try {
      await apiFetch(`/api/counts/${detail.count.id}/validate`, {
        method: 'POST',
        body: JSON.stringify({ chiefNotes }),
      });
      setMessage('Conteo validado por Control de Stock. Puede registrar regularizaciones y proceder al cierre.');
      await loadCounts();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const handleRequestRecount = async () => {
    if (!detail) return;
    setError(null);
    setMessage(null);
    try {
      const itemReasons = Object.entries(recountReasons)
        .filter(([, r]) => r.trim() !== '')
        .map(([itemId, reason]) => ({ itemId: Number(itemId), reason }));

      await apiFetch(`/api/counts/${detail.count.id}/request-recount`, {
        method: 'POST',
        body: JSON.stringify({ itemReasons, chiefObservations: chiefNotes }),
      });
      setMessage('Reconteo independiente solicitado. Se notificó al responsable asignado.');
      await loadCounts();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const handleSaveRegularization = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail || !regTarget) return;
    setError(null);
    try {
      await apiFetch(`/api/counts/${detail.count.id}/items/${regTarget.id}/regularize`, {
        method: 'POST',
        body: JSON.stringify(regForm),
      });
      setRegTarget(null);
      setMessage('Regularización registrada con trazabilidad.');
      await loadCounts();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const handleCloseCount = async () => {
    if (!detail) return;
    setError(null);
    setMessage(null);
    try {
      await apiFetch(`/api/counts/${detail.count.id}/close`, {
        method: 'POST',
        body: JSON.stringify({ chiefSignatureName: chiefSig }),
      });
      setMessage('Conteo cerrado permanentemente con firma final y actualización de trazabilidad.');
      await loadCounts();
    } catch (err: unknown) {
      setError((err as Error).message);
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

  const filteredCounts = counts.filter((c) => {
    if (filterStatus === 'PENDING') {
      return [
        CountStatus.ENVIADO_REVISION,
        CountStatus.RECONTEO_SOLICITADO,
        CountStatus.VALIDADO,
      ].includes(c.status);
    }
    if (filterStatus === 'CLOSED') return c.status === CountStatus.CERRADO;
    return true;
  });

  const isClosed = detail?.count.status === CountStatus.CERRADO;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">
            Validación, Reconteos y Cierre de Ajustes
          </h2>
          <p className="text-sm text-slate-600 mt-0.5">
            Bandeja ejecutiva del Jefe de Control de Stock. Ninguna diferencia se cierra automáticamente sin validación, comprobante y firma final.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
          {[
            ['PENDING', 'Bandeja Pendiente'],
            ['CLOSED', 'Cerrados (Histórico)'],
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
            <div className="divide-y divide-slate-100 max-h-[620px] overflow-y-auto">
              {filteredCounts.map((c) => (
                <button
                  key={c.id}
                  onClick={() => openDetail(c.id)}
                  className={`w-full text-left p-3.5 hover:bg-slate-50 ${
                    selectedId === c.id ? 'bg-blue-50/70' : ''
                  }`}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono font-bold text-slate-900">{c.count_number}</span>
                    <span
                      className={`font-medium ${
                        c.status === CountStatus.ENVIADO_REVISION
                          ? 'text-amber-700'
                          : c.status === CountStatus.CERRADO
                            ? 'text-emerald-700'
                            : 'text-blue-700'
                      }`}
                    >
                      {c.status}
                    </span>
                  </div>
                  <div className="text-xs font-medium text-slate-800 mt-1">{c.location_name}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    {c.scheduled_date} · {c.counter_name} ·{' '}
                    <span className={c.discrepancies_count > 0 ? 'text-red-700 font-semibold' : ''}>
                      {c.discrepancies_count} dif.
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5 space-y-5">
          {!detail ? (
            <div className="py-16 text-center text-sm text-slate-500">
              <FileCheck2 className="w-8 h-8 text-slate-400 mx-auto mb-2" />
              Seleccione un conteo para auditar la conciliación, solicitar reconteos, registrar ajustes del ERP y ejecutar el cierre definitivo.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-200">
                <div>
                  <div className="text-xs font-mono text-slate-500">
                    {String(detail.count.count_number)} · {String(detail.count.status)}
                  </div>
                  <h3 className="text-lg font-bold text-slate-900">
                    {String(detail.count.location_name)}
                  </h3>
                  <div className="text-xs text-slate-600 mt-0.5">
                    Contador: {String(detail.count.counter_name)} · Firma Contador:{' '}
                    {String(detail.count.counter_signature_name || 'Pendiente')} · Firma Depósito:{' '}
                    {String(detail.count.warehouse_signature_name || 'Pendiente')}
                  </div>
                </div>
                {isClosed && (
                  <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                    <Lock className="w-4 h-4" />
                    Cerrado Definitivamente ({String(detail.count.closed_at).slice(0, 16)})
                  </div>
                )}
              </div>

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
                      <th className="py-2 px-2.5 text-right">R2 (Reconteo)</th>
                      <th className="py-2 px-2.5 text-right">Dif. Final</th>
                      <th className="py-2 px-2.5">Regularización ERP</th>
                      {!isClosed && <th className="py-2 px-2.5">Acción</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {detail.items.map((it) => {
                      const hasDiff =
                        it.reconciliation_result === 'FALTANTE' ||
                        it.reconciliation_result === 'SOBRANTE';
                      return (
                        <React.Fragment key={String(it.id)}>
                          <tr className="border-b border-slate-100">
                            <td className="py-2 px-2.5">
                              <div className="font-mono font-semibold text-slate-900">
                                {String(it.sku)}
                              </div>
                              <div className="text-slate-700">{String(it.description)}</div>
                            </td>
                            <td className="py-2 px-2.5 text-right font-mono tabular-nums">
                              {Number(it.snapshot_erp_stock)}
                            </td>
                            <td className="py-2 px-2.5 text-right font-mono tabular-nums">
                              <div>{it.counted_qty !== null ? Number(it.counted_qty) : '—'}</div>
                              {it.bulk_qty !== null &&
                                it.bulk_qty !== undefined &&
                                it.loose_qty !== null &&
                                it.loose_qty !== undefined && (
                                  <div className="text-[10px] text-slate-500">
                                    {Number(it.bulk_qty)} B + {Number(it.loose_qty)} S
                                  </div>
                                )}
                            </td>
                            <td className="py-2 px-2.5 text-right font-mono tabular-nums text-blue-700">
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
                              className={`py-2 px-2.5 text-right font-mono font-bold tabular-nums ${
                                Number(it.difference || 0) < 0
                                  ? 'text-red-700'
                                  : Number(it.difference || 0) > 0
                                    ? 'text-amber-700'
                                    : 'text-emerald-700'
                              }`}
                            >
                              {it.difference !== null
                                ? `${Number(it.difference) > 0 ? '+' : ''}${Number(it.difference)}`
                                : '—'}
                            </td>
                            <td className="py-2 px-2.5">
                              {!hasDiff ? (
                                <span className="text-emerald-700">Coincidencia</span>
                              ) : (
                                <div>
                                  <div className="font-semibold text-slate-900">
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
                            {!isClosed && (
                              <td className="py-2 px-2.5 space-y-1">
                                {hasDiff && (
                                  <button
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
                                          it.regularization_date || new Date().toISOString().slice(0, 10)
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
                                <input
                                  type="text"
                                  placeholder="Motivo reconteo..."
                                  value={recountReasons[Number(it.id)] || ''}
                                  onChange={(e) =>
                                    setRecountReasons({
                                      ...recountReasons,
                                      [Number(it.id)]: e.target.value,
                                    })
                                  }
                                  className="w-32 px-1.5 py-0.5 text-[11px] border border-slate-300 rounded"
                                />
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

              {/* Evidence Attachments */}
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-slate-800">Documentación Respaldatoria ERP:</span>
                  {detail.sheetAttachments.length === 0 ? (
                    <span className="text-slate-500">Sin comprobantes adjuntos aún</span>
                  ) : (
                    detail.sheetAttachments.map((a) => (
                      <span key={a.id} className="inline-flex items-center gap-1 text-blue-700 font-medium">
                        <Paperclip className="w-3 h-3" />
                        {a.original_name}
                      </span>
                    ))
                  )}
                </div>
                {!isClosed && (
                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-300 rounded-lg cursor-pointer hover:bg-slate-50 font-medium">
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

              {/* Validation & Closure Controls */}
              {!isClosed && (
                <div className="pt-4 border-t border-slate-200 space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">
                        Observaciones del Jefe de Control de Stock
                      </label>
                      <input
                        type="text"
                        value={chiefNotes}
                        onChange={(e) => setChiefNotes(e.target.value)}
                        placeholder="Conclusiones de auditoría o instrucción de reconteo..."
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">
                        Firma Final Jefe de Control de Stock (para cierre)
                      </label>
                      <input
                        type="text"
                        value={chiefSig}
                        onChange={(e) => setChiefSig(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <button
                      onClick={handleRequestRecount}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-300 rounded-lg hover:bg-amber-100"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Solicitar Reconteo Independiente
                    </button>

                    <div className="flex items-center gap-2">
                      {detail.count.status !== CountStatus.VALIDADO && (
                        <button
                          onClick={handleValidate}
                          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-[#8e0d0d] text-white rounded-lg hover:bg-[#6e0909]"
                        >
                          <ShieldCheck className="w-3.5 h-3.5" />
                          Validar Resultado
                        </button>
                      )}
                      <button
                        onClick={handleCloseCount}
                        disabled={detail.count.status !== CountStatus.VALIDADO}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50"
                      >
                        <Lock className="w-3.5 h-3.5" />
                        Cerrar Conteo Definitivamente
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Regularization Modal */}
      {regTarget && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6">
            <h3 className="text-base font-bold text-slate-900 mb-1">
              Regularización de Diferencia
            </h3>
            <p className="text-xs text-slate-500 mb-4">
              {String(regTarget.sku)} · {String(regTarget.description)} (Dif:{' '}
              {Number(regTarget.difference)})
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
                  <option value={AdjustmentOperationType.MOVIMIENTO}>Movimiento entre Depósitos ERP</option>
                  <option value={AdjustmentOperationType.SIN_AJUSTE}>Sin ajuste (Justificado)</option>
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
