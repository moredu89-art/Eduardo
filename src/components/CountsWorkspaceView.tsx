import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  FileSpreadsheet,
  Paperclip,
  Printer,
  Save,
  Send,
  ShieldAlert,
} from 'lucide-react';
import { apiFetch, getAuthToken } from '../lib/api';
import { exportBlindCountSheetPdf, MERCOMAT_LOGO_URL } from '../lib/pdfExport';
import { AuthUser, CountStatus, UserRole } from '../types/erp';

interface CountSummary {
  id: number;
  count_number: string;
  document_uid: string;
  location_id: number;
  location_name: string;
  location_group: string;
  scheduled_date: string;
  assigned_counter_id: number;
  counter_name: string;
  warehouse_manager_name: string | null;
  status: CountStatus;
  items_count: number;
  counted_items_count: number;
  discrepancies_count: number | null;
  weekly_goal_tag: string;
  counter_signature_name: string;
  warehouse_signature_name: string;
  chief_signature_name: string;
}

interface CountItemDetail {
  id: number;
  product_id: number;
  sku: string;
  description: string;
  family?: string;
  brand?: string;
  unit_of_measure: string;
  snapshot_erp_stock: number | null;
  snapshot_committed_stock: number | null;
  bulk_qty: number | null;
  loose_qty: number | null;
  counted_qty: number | null;
  recount_bulk_qty: number | null;
  recount_loose_qty: number | null;
  recount_qty: number | null;
  final_counted_qty: number | null;
  difference: number | null;
  reconciliation_result: string | null;
  counter_observations: string;
  recount_requested_reason: string;
  historical_alert_text: string | null;
  attachments: Array<{ id: number; original_name: string; mime_type: string }>;
}

interface CountItemInputState {
  bulkQty: string;
  looseQty: string;
  obs: string;
}

function isValidRequiredQty(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  const num = Number(trimmed);
  return Number.isFinite(num) && num >= 0;
}

export const CountsWorkspaceView: React.FC<{ currentUser: AuthUser }> = ({ currentUser }) => {
  const [counts, setCounts] = useState<CountSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<{
    count: Record<string, unknown>;
    items: CountItemDetail[];
    isBlindRestricted: boolean;
    postSnapshotMovements: Array<Record<string, unknown>>;
  } | null>(null);

  const [inputs, setInputs] = useState<Record<number, CountItemInputState>>({});
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [counterSig, setCounterSig] = useState(currentUser.fullName);
  const [whSig, setWhSig] = useState(currentUser.fullName);
  const [whNotes, setWhNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadCounts = async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ counts: CountSummary[] }>('/api/counts');
      setCounts(res.counts);
      if (selectedId) {
        await openCount(selectedId);
      }
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCounts();
  }, []);

  const openCount = async (id: number) => {
    setSelectedId(id);
    setError(null);
    setValidationAttempted(false);
    try {
      const res = await apiFetch<{
        count: Record<string, unknown>;
        items: CountItemDetail[];
        isBlindRestricted: boolean;
        postSnapshotMovements: Array<Record<string, unknown>>;
      }>(`/api/counts/${id}`);
      setDetail(res);
      const isRecount = res.count.status === CountStatus.RECONTEO_SOLICITADO;
      const map: Record<number, CountItemInputState> = {};
      for (const it of res.items) {
        const bulkVal = isRecount ? it.recount_bulk_qty : it.bulk_qty;
        const looseVal = isRecount ? it.recount_loose_qty : it.loose_qty;
        const legacyTotal = isRecount ? it.recount_qty : it.counted_qty;
        map[it.id] = {
          bulkQty:
            bulkVal !== null && bulkVal !== undefined
              ? String(bulkVal)
              : legacyTotal !== null && legacyTotal !== undefined
                ? String(legacyTotal)
                : '',
          looseQty: looseVal !== null && looseVal !== undefined ? String(looseVal) : '',
          obs: it.counter_observations || '',
        };
      }
      setInputs(map);
      setWhNotes(String(res.count.warehouse_confirmed_notes || ''));
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const handlePrintBlindPdf = async () => {
    if (!detail) return;
    await apiFetch(`/api/counts/${detail.count.id}/mark-printed`, { method: 'POST' });
    const uniqueFamilies = Array.from(
      new Set(detail.items.map((i) => i.family).filter((v): v is string => Boolean(v)))
    );
    const uniqueBrands = Array.from(
      new Set(detail.items.map((i) => i.brand).filter((v): v is string => Boolean(v)))
    );
    const nowTime = new Date().toLocaleTimeString('es-AR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    await exportBlindCountSheetPdf({
      countNumber: String(detail.count.count_number),
      documentUid: String(detail.count.document_uid),
      scheduledDate: String(detail.count.scheduled_date),
      scheduledTime: nowTime,
      locationName: String(detail.count.location_name),
      locationGroup: String(detail.count.location_group),
      familyLabel:
        uniqueFamilies.length === 1
          ? uniqueFamilies[0]
          : uniqueFamilies.length > 1
            ? `Varias (${uniqueFamilies.slice(0, 3).join(', ')})`
            : 'General',
      rubroLabel:
        uniqueBrands.length === 1
          ? uniqueBrands[0]
          : uniqueBrands.length > 1
            ? 'Varios rubros'
            : 'General',
      counterName: String(detail.count.counter_name),
      items: detail.items.map((i) => ({
        sku: i.sku,
        description: i.description,
        unitOfMeasure: i.unit_of_measure,
      })),
    });
    await loadCounts();
  };

  const handleImportExcelResults = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !detail) return;
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const token = getAuthToken();
      const res = await fetch(`/api/counts/${detail.count.id}/import-results-excel`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error leyendo archivo de conteo');

      const nextInputs = { ...inputs };
      for (const m of data.matched as Array<{
        itemId: number;
        bulkQty: number | null;
        looseQty: number | null;
        countedQty: number;
        observations: string;
      }>) {
        nextInputs[m.itemId] = {
          bulkQty:
            m.bulkQty !== null && m.bulkQty !== undefined
              ? String(m.bulkQty)
              : String(m.countedQty),
          looseQty: m.looseQty !== null && m.looseQty !== undefined ? String(m.looseQty) : '',
          obs: m.observations || nextInputs[m.itemId]?.obs || '',
        };
      }
      setInputs(nextInputs);
      setMessage(`Se cargaron ${data.matchedCount} artículo(s) desde el archivo Excel/CSV.`);
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const handleUploadAttachment = async (entityType: string, entityId: number, file: File) => {
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('entityType', entityType);
      fd.append('entityId', String(entityId));
      const token = getAuthToken();
      const res = await fetch('/api/attachments', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo adjuntar archivo');
      setMessage(`Archivo "${data.original_name}" adjuntado correctamente.`);
      if (selectedId) await openCount(selectedId);
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const incompleteItems = detail
    ? detail.items
        .map((it) => {
          const entry = inputs[it.id] || { bulkQty: '', looseQty: '', obs: '' };
          const missingBulk = !isValidRequiredQty(entry.bulkQty);
          const missingLoose = !isValidRequiredQty(entry.looseQty);
          return { id: it.id, sku: it.sku, missingBulk, missingLoose };
        })
        .filter((x) => x.missingBulk || x.missingLoose)
    : [];

  const handleSaveOrSubmit = async (submitForReview: boolean) => {
    if (!detail) return;
    setError(null);
    setMessage(null);

    if (submitForReview && incompleteItems.length > 0) {
      setValidationAttempted(true);
      const previewSkus = incompleteItems
        .slice(0, 4)
        .map((x) => {
          const cols = [
            x.missingBulk ? 'Unidades/Bultos' : '',
            x.missingLoose ? 'Unidades Sueltas' : '',
          ]
            .filter(Boolean)
            .join(' y ');
          return `${x.sku} (${cols})`;
        })
        .join(', ');
      setError(
        `No se puede enviar el registro: debe completar tanto "Unidades / Bultos" como "Unidades Sueltas" en todos los artículos. Pendientes (${incompleteItems.length}): ${previewSkus}${
          incompleteItems.length > 4 ? '...' : ''
        }.`
      );
      return;
    }

    // Check for negative or invalid numbers even when saving a draft
    for (const it of detail.items) {
      const entry = inputs[it.id] || { bulkQty: '', looseQty: '', obs: '' };
      if (entry.bulkQty.trim() !== '' && !isValidRequiredQty(entry.bulkQty)) {
        setValidationAttempted(true);
        setError(`El valor de "Unidades / Bultos" en ${it.sku} debe ser un número válido mayor o igual a 0.`);
        return;
      }
      if (entry.looseQty.trim() !== '' && !isValidRequiredQty(entry.looseQty)) {
        setValidationAttempted(true);
        setError(`El valor de "Unidades Sueltas" en ${it.sku} debe ser un número válido mayor o igual a 0.`);
        return;
      }
    }

    setSaving(true);
    try {
      const payloadItems = detail.items.map((it) => {
        const entry = inputs[it.id] || { bulkQty: '', looseQty: '', obs: '' };
        const bulk = entry.bulkQty.trim() === '' ? null : Number(entry.bulkQty);
        const loose = entry.looseQty.trim() === '' ? null : Number(entry.looseQty);
        const countedQty =
          bulk !== null && loose !== null ? Math.round((bulk + loose) * 10000) / 10000 : null;
        return {
          itemId: it.id,
          bulkQty: bulk,
          looseQty: loose,
          countedQty,
          observations: entry.obs ?? '',
        };
      });

      await apiFetch(`/api/counts/${detail.count.id}/submit-results`, {
        method: 'POST',
        body: JSON.stringify({
          items: payloadItems,
          counterSignatureName: counterSig,
          submitForReview,
        }),
      });

      setValidationAttempted(false);
      setMessage(
        submitForReview
          ? 'Conteo enviado para revisión y conciliación automática ejecutada.'
          : 'Borrador guardado correctamente.'
      );
      await loadCounts();
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleWarehouseSign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    setError(null);
    try {
      await apiFetch(`/api/counts/${detail.count.id}/warehouse-sign`, {
        method: 'POST',
        body: JSON.stringify({ signatureName: whSig, notes: whNotes }),
      });
      setMessage('Conformidad y firma del Responsable de Depósito registradas.');
      await loadCounts();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const canCounterEdit =
    detail &&
    (currentUser.role === UserRole.CONTADOR || currentUser.role === UserRole.JEFE_STOCK) &&
    [CountStatus.PROGRAMADO, CountStatus.EN_PROGRESO, CountStatus.RECONTEO_SOLICITADO].includes(
      detail.count.status as CountStatus
    );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">
          Ejecución de Conteos Ciegos y Conciliación
        </h2>
        <p className="text-sm text-slate-600 mt-0.5">
          Planillas ciegas imprimibles en PDF, carga manual o Excel, evidencia fotográfica y conciliación automática con alertas históricas.
        </p>
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
        {/* Left List */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 text-xs font-bold text-slate-900">
            Conteos Asignados ({counts.length})
          </div>
          {loading ? (
            <div className="p-6 text-xs text-slate-500 text-center">Cargando...</div>
          ) : counts.length === 0 ? (
            <div className="p-6 text-xs text-slate-500 text-center">
              No hay conteos programados para su perfil.
            </div>
          ) : (
            <div className="divide-y divide-slate-100 max-h-[600px] overflow-y-auto">
              {counts.map((c) => (
                <button
                  key={c.id}
                  onClick={() => openCount(c.id)}
                  className={`w-full text-left p-3.5 transition-colors hover:bg-slate-50 ${
                    selectedId === c.id ? 'bg-blue-50/70' : ''
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-mono font-bold text-slate-900">{c.count_number}</span>
                    <span className="font-medium text-slate-700">{c.status}</span>
                  </div>
                  <div className="text-xs font-medium text-slate-800 mt-1">{c.location_name}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    {c.scheduled_date} · {c.counter_name} · {c.counted_items_count}/{c.items_count} ítems
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right Detail */}
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5 space-y-5">
          {!detail ? (
            <div className="py-16 text-center text-sm text-slate-500">
              <ClipboardCheck className="w-8 h-8 text-slate-400 mx-auto mb-2" />
              Seleccione un conteo de la lista para imprimir su planilla ciega, cargar cantidades o revisar la conciliación.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-200">
                <div className="flex items-start gap-3">
                  <img
                    src={MERCOMAT_LOGO_URL}
                    alt="MercoMat"
                    referrerPolicy="no-referrer"
                    className="w-11 h-11 rounded-lg object-cover border border-slate-200 shrink-0"
                  />
                  <div>
                    <div className="text-xs font-mono text-slate-500">
                      MercoMat · {String(detail.count.count_number)} · ID{' '}
                      {String(detail.count.document_uid)} · {String(detail.count.status)}
                    </div>
                    <h3 className="text-lg font-bold text-slate-900 mt-0.5">
                      {String(detail.count.location_name)}
                    </h3>
                    <div className="text-xs text-slate-600 mt-0.5">
                      Fecha: <span className="font-mono">{String(detail.count.scheduled_date)}</span> ·
                      Contador: {String(detail.count.counter_name)}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={handlePrintBlindPdf}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#8e0d0d] text-white rounded-lg hover:bg-[#6e0909]"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    Imprimir Planilla Ciega (PDF)
                  </button>

                  {canCounterEdit && (
                    <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 cursor-pointer">
                      <FileSpreadsheet className="w-3.5 h-3.5" />
                      Importar Excel Resultados
                      <input
                        type="file"
                        accept=".xlsx,.xls,.csv"
                        onChange={handleImportExcelResults}
                        className="hidden"
                      />
                    </label>
                  )}
                </div>
              </div>

              {detail.isBlindRestricted && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-blue-700 shrink-0" />
                  <span>
                    <strong>Modo Conteo Ciego Activo:</strong> Las existencias teóricas del ERP y posibles diferencias permanecen ocultas hasta completar y enviar el relevamiento físico.
                  </span>
                </div>
              )}

              {detail.postSnapshotMovements.length > 0 && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 space-y-1">
                  <div className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4" />
                    Advertencia de Trazabilidad: se registraron {detail.postSnapshotMovements.length}{' '}
                    movimiento(s) posteriores a la toma de fotografía teórica del conteo.
                  </div>
                  <div className="text-[11px]">
                    Revise estos movimientos antes de validar la conciliación para evitar falsas diferencias.
                  </div>
                </div>
              )}

              {/* Items Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
                      <th className="py-2 px-2.5">Código</th>
                      <th className="py-2 px-2.5">Descripción</th>
                      {!detail.isBlindRestricted && (
                        <>
                          <th className="py-2 px-2.5 text-right">ERP</th>
                          <th className="py-2 px-2.5 text-right">Compr.</th>
                        </>
                      )}
                      <th className="py-2 px-2.5 text-right whitespace-nowrap">
                        Unidades / Bultos <span className="text-red-600">*</span>
                      </th>
                      <th className="py-2 px-2.5 text-right whitespace-nowrap">
                        Unidades Sueltas <span className="text-red-600">*</span>
                      </th>
                      <th className="py-2 px-2.5 text-right whitespace-nowrap">
                        {detail.count.status === CountStatus.RECONTEO_SOLICITADO
                          ? 'Total R2'
                          : 'Total Físico'}
                      </th>
                      {!detail.isBlindRestricted && (
                        <>
                          <th className="py-2 px-2.5 text-right">Diferencia</th>
                          <th className="py-2 px-2.5">Resultado</th>
                        </>
                      )}
                      <th className="py-2 px-2.5">Observaciones / Foto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.items.map((it) => {
                      const entry = inputs[it.id] || { bulkQty: '', looseQty: '', obs: '' };
                      const bulkValid = isValidRequiredQty(entry.bulkQty);
                      const looseValid = isValidRequiredQty(entry.looseQty);
                      const rowTotal =
                        bulkValid && looseValid
                          ? Math.round((Number(entry.bulkQty) + Number(entry.looseQty)) * 10000) /
                            10000
                          : null;
                      const isRecount = detail.count.status === CountStatus.RECONTEO_SOLICITADO;
                      const displayBulk = isRecount ? it.recount_bulk_qty : it.bulk_qty;
                      const displayLoose = isRecount ? it.recount_loose_qty : it.loose_qty;

                      return (
                        <React.Fragment key={it.id}>
                          <tr className="border-b border-slate-100">
                            <td className="py-2 px-2.5 font-mono font-semibold text-slate-900">
                              {it.sku}
                            </td>
                            <td className="py-2 px-2.5">
                              <div className="font-medium text-slate-900">{it.description}</div>
                              <div className="text-[11px] text-slate-500">{it.unit_of_measure}</div>
                              {it.recount_requested_reason && (
                                <div className="text-[11px] text-amber-700 mt-0.5">
                                  Motivo reconteo: {it.recount_requested_reason}
                                </div>
                              )}
                            </td>
                            {!detail.isBlindRestricted && (
                              <>
                                <td className="py-2 px-2.5 text-right font-mono tabular-nums">
                                  {it.snapshot_erp_stock}
                                </td>
                                <td className="py-2 px-2.5 text-right font-mono tabular-nums text-slate-500">
                                  {it.snapshot_committed_stock}
                                </td>
                              </>
                            )}
                            <td className="py-2 px-2.5 text-right align-top">
                              {canCounterEdit ? (
                                <div className="inline-flex flex-col items-end">
                                  <input
                                    type="number"
                                    min={0}
                                    step="any"
                                    required
                                    aria-label={`Unidades / Bultos para ${it.sku}`}
                                    aria-invalid={!bulkValid}
                                    value={entry.bulkQty}
                                    onChange={(e) =>
                                      setInputs({
                                        ...inputs,
                                        [it.id]: {
                                          ...entry,
                                          bulkQty: e.target.value,
                                        },
                                      })
                                    }
                                    placeholder="0"
                                    className={`w-24 px-2 py-1 text-right font-mono border rounded ${
                                      !bulkValid
                                        ? validationAttempted
                                          ? 'border-red-500 bg-red-50/70 text-red-900'
                                          : 'border-amber-400 bg-amber-50/30'
                                        : 'border-slate-300 bg-white'
                                    }`}
                                  />
                                  {validationAttempted && !bulkValid && (
                                    <span className="text-[10px] text-red-600 mt-0.5">
                                      Requerido
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <span className="font-mono tabular-nums text-slate-700">
                                  {displayBulk ?? '—'}
                                </span>
                              )}
                            </td>
                            <td className="py-2 px-2.5 text-right align-top">
                              {canCounterEdit ? (
                                <div className="inline-flex flex-col items-end">
                                  <input
                                    type="number"
                                    min={0}
                                    step="any"
                                    required
                                    aria-label={`Unidades Sueltas para ${it.sku}`}
                                    aria-invalid={!looseValid}
                                    value={entry.looseQty}
                                    onChange={(e) =>
                                      setInputs({
                                        ...inputs,
                                        [it.id]: {
                                          ...entry,
                                          looseQty: e.target.value,
                                        },
                                      })
                                    }
                                    placeholder="0"
                                    className={`w-24 px-2 py-1 text-right font-mono border rounded ${
                                      !looseValid
                                        ? validationAttempted
                                          ? 'border-red-500 bg-red-50/70 text-red-900'
                                          : 'border-amber-400 bg-amber-50/30'
                                        : 'border-slate-300 bg-white'
                                    }`}
                                  />
                                  {validationAttempted && !looseValid && (
                                    <span className="text-[10px] text-red-600 mt-0.5">
                                      Requerido
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <span className="font-mono tabular-nums text-slate-700">
                                  {displayLoose ?? '—'}
                                </span>
                              )}
                            </td>
                            <td className="py-2 px-2.5 text-right">
                              {canCounterEdit ? (
                                <span
                                  className={`font-mono font-semibold tabular-nums ${
                                    rowTotal !== null ? 'text-slate-900' : 'text-amber-700 text-[11px]'
                                  }`}
                                >
                                  {rowTotal !== null ? rowTotal : 'Incompleto'}
                                </span>
                              ) : (
                                <span className="font-mono font-semibold tabular-nums">
                                  {it.final_counted_qty ?? '—'}
                                </span>
                              )}
                            </td>
                            {!detail.isBlindRestricted && (
                              <>
                                <td
                                  className={`py-2 px-2.5 text-right font-mono font-bold tabular-nums ${
                                    (it.difference || 0) < 0
                                      ? 'text-red-700'
                                      : (it.difference || 0) > 0
                                        ? 'text-amber-700'
                                        : 'text-emerald-700'
                                  }`}
                                >
                                  {it.difference !== null
                                    ? `${it.difference > 0 ? '+' : ''}${it.difference}`
                                    : '—'}
                                </td>
                                <td className="py-2 px-2.5 font-medium">
                                  {it.reconciliation_result || 'Pendiente'}
                                </td>
                              </>
                            )}
                            <td className="py-2 px-2.5 space-y-1">
                              {canCounterEdit ? (
                                <input
                                  type="text"
                                  value={entry.obs}
                                  onChange={(e) =>
                                    setInputs({
                                      ...inputs,
                                      [it.id]: {
                                        ...entry,
                                        obs: e.target.value,
                                      },
                                    })
                                  }
                                  placeholder="Obs..."
                                  className="w-full px-2 py-1 border border-slate-300 rounded text-xs"
                                />
                              ) : (
                                <span className="text-slate-600">
                                  {it.counter_observations || '—'}
                                </span>
                              )}
                              <div className="flex flex-wrap items-center gap-2">
                                {canCounterEdit && (
                                  <label className="inline-flex items-center gap-1 text-[11px] text-blue-700 hover:underline cursor-pointer">
                                    <Camera className="w-3 h-3" />
                                    Adjuntar foto
                                    <input
                                      type="file"
                                      accept="image/*,.pdf"
                                      onChange={(e) => {
                                        const f = e.target.files?.[0];
                                        if (f) handleUploadAttachment('COUNT_ITEM', it.id, f);
                                      }}
                                      className="hidden"
                                    />
                                  </label>
                                )}
                                {it.attachments.map((att) => (
                                  <span
                                    key={att.id}
                                    className="inline-flex items-center gap-1 text-[11px] text-slate-600"
                                  >
                                    <Paperclip className="w-3 h-3" />
                                    {att.original_name}
                                  </span>
                                ))}
                              </div>
                            </td>
                          </tr>
                          {!detail.isBlindRestricted &&
                            it.historical_alert_text &&
                            it.reconciliation_result !== 'COINCIDENCIA' && (
                              <tr className="bg-red-50/60 border-b border-red-100">
                                <td
                                  colSpan={10}
                                  className="px-3 py-2 text-[11px] text-red-800 font-medium"
                                >
                                  <AlertTriangle className="w-3.5 h-3.5 inline mr-1.5" />
                                  {it.historical_alert_text}
                                </td>
                              </tr>
                            )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Counter submission actions */}
              {canCounterEdit && (
                <div className="pt-4 border-t border-slate-200 space-y-3">
                  {incompleteItems.length > 0 && (
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-semibold">
                          Validación obligatoria para enviar:
                        </span>{' '}
                        Complete tanto <strong>Unidades / Bultos</strong> como{' '}
                        <strong>Unidades Sueltas</strong> en todos los artículos (ingrese{' '}
                        <span className="font-mono font-semibold">0</span> si no hay existencias en
                        esa columna). Faltan{' '}
                        <strong className="tabular-nums">{incompleteItems.length}</strong>{' '}
                        artículo(s):{' '}
                        <span className="font-mono">
                          {incompleteItems
                            .slice(0, 5)
                            .map((x) => x.sku)
                            .join(', ')}
                          {incompleteItems.length > 5 ? '...' : ''}
                        </span>
                        .
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap items-end justify-between gap-4">
                    <div className="w-full sm:w-64">
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Firma Digital Responsable de Conteo
                      </label>
                      <input
                        type="text"
                        value={counterSig}
                        onChange={(e) => setCounterSig(e.target.value)}
                        className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleSaveOrSubmit(false)}
                        disabled={saving}
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 whitespace-nowrap"
                      >
                        <Save className="w-3.5 h-3.5" />
                        Guardar Borrador
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSaveOrSubmit(true)}
                        disabled={saving || incompleteItems.length > 0}
                        title={
                          incompleteItems.length > 0
                            ? 'Complete Unidades / Bultos y Unidades Sueltas en todos los artículos para habilitar el envío'
                            : 'Enviar conteo para revisión'
                        }
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-[#8e0d0d] text-white rounded-lg hover:bg-[#6e0909] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                      >
                        <Send className="w-3.5 h-3.5" />
                        Enviar Conteo para Revisión
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Warehouse Manager Signature */}
              {(currentUser.role === UserRole.RESPONSABLE_DEPOSITO ||
                currentUser.role === UserRole.JEFE_STOCK) &&
                detail.count.status !== CountStatus.CERRADO && (
                  <form
                    onSubmit={handleWarehouseSign}
                    className="pt-4 border-t border-slate-200 bg-slate-50 p-4 rounded-lg space-y-3"
                  >
                    <div className="text-xs font-bold text-slate-900">
                      Conformidad del Responsable de Depósito (No modifica cantidades contadas)
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                      <div>
                        <label className="block text-slate-600 mb-1">Firma Responsable Depósito</label>
                        <input
                          type="text"
                          required
                          value={whSig}
                          onChange={(e) => setWhSig(e.target.value)}
                          className="w-full px-3 py-1.5 border border-slate-300 rounded bg-white"
                        />
                      </div>
                      <div>
                        <label className="block text-slate-600 mb-1">Observaciones en Depósito</label>
                        <input
                          type="text"
                          value={whNotes}
                          onChange={(e) => setWhNotes(e.target.value)}
                          placeholder="Confirmación de presencia y condiciones..."
                          className="w-full px-3 py-1.5 border border-slate-300 rounded bg-white"
                        />
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-500">
                        {detail.count.warehouse_signature_name
                          ? `Firmado por: ${String(detail.count.warehouse_signature_name)}`
                          : 'Pendiente de firma del depósito'}
                      </span>
                      <button
                        type="submit"
                        className="px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-lg"
                      >
                        Confirmar y Firmar Depósito
                      </button>
                    </div>
                  </form>
                )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
