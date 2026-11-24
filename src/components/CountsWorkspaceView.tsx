import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  Download,
  FileSpreadsheet,
  Paperclip,
  Printer,
  RotateCcw,
  Save,
  Send,
  ShieldAlert,
  Upload,
} from 'lucide-react';
import { apiFetch, getAuthToken } from '../lib/api';
import { getCountStatusMeta } from '../lib/countStatus';
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
  assigned_counter_id: number | null;
  counter_name: string;
  warehouse_manager_name: string | null;
  status: CountStatus;
  items_count: number;
  counted_items_count: number;
  not_counted_items_count?: number;
  discrepancies_count: number | null;
  weekly_goal_tag: string;
  counter_signature_name: string;
  warehouse_signature_name: string;
  chief_signature_name: string;
  attachments_count?: number;
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
  is_not_counted?: number;
  not_counted_reason?: string;
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

interface CountSubmissionSummary {
  id: number;
  version_number: number;
  submitted_by_full_name: string | null;
  submitted_by_username: string;
  counter_signature_name: string;
  warehouse_signature_name: string;
  general_observations: string;
  outcome_status: string;
  review_notes: string;
  reviewed_at: string | null;
  created_at: string;
}

interface CountItemInputState {
  bulkQty: string;
  looseQty: string;
  isNotCounted: boolean;
  notCountedReason: string;
  obs: string;
}

function isValidOptionalQty(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '') return true;
  const num = Number(trimmed);
  return Number.isFinite(num) && num >= 0;
}

interface CountsWorkspaceViewProps {
  currentUser: AuthUser;
  initialCountId?: number | null;
}

export const CountsWorkspaceView: React.FC<CountsWorkspaceViewProps> = ({
  currentUser,
  initialCountId = null,
}) => {
  const [counts, setCounts] = useState<CountSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(initialCountId);
  const [detail, setDetail] = useState<{
    count: Record<string, unknown>;
    items: CountItemDetail[];
    isBlindRestricted: boolean;
    postSnapshotMovements: Array<Record<string, unknown>>;
    sheetAttachments: Array<{ id: number; original_name: string; mime_type: string }>;
    submissions: CountSubmissionSummary[];
  } | null>(null);

  const [inputs, setInputs] = useState<Record<number, CountItemInputState>>({});
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [counterSig, setCounterSig] = useState(currentUser.fullName);
  const [generalObservations, setGeneralObservations] = useState('');
  const [whSig, setWhSig] = useState(currentUser.fullName);
  const [whNotes, setWhNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        sheetAttachments?: Array<{ id: number; original_name: string; mime_type: string }>;
        submissions?: CountSubmissionSummary[];
      }>(`/api/counts/${id}`);

      setDetail({
        count: res.count,
        items: res.items,
        isBlindRestricted: res.isBlindRestricted,
        postSnapshotMovements: res.postSnapshotMovements || [],
        sheetAttachments: res.sheetAttachments || [],
        submissions: res.submissions || [],
      });

      const isRecount = Boolean(res.count.rejected_at) || (res.submissions?.length || 0) > 0;
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
          isNotCounted: Number(it.is_not_counted || 0) === 1,
          notCountedReason: it.not_counted_reason || '',
          obs: it.counter_observations || '',
        };
      }
      setInputs(map);
      setCounterSig(String(res.count.counter_signature_name || currentUser.fullName));
      setGeneralObservations(String(res.count.counter_general_notes || ''));
      setWhNotes(String(res.count.warehouse_confirmed_notes || ''));
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
        await openCount(idToOpen);
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

  const handleReopenCount = async () => {
    if (!detail) return;
    setError(null);
    setMessage(null);
    setSaving(true);
    try {
      await apiFetch(`/api/counts/${detail.count.id}/reopen`, { method: 'POST' });
      setMessage('Conteo devuelto a estado EJECUCIÓN. Ya puede corregir cantidades y volver a entregar.');
      await loadCounts(Number(detail.count.id));
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadExcel = async () => {
    if (!detail) return;
    setError(null);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/counts/${detail.count.id}/export-excel`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'No se pudo descargar la planilla Excel');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Planilla_Conteo_${String(detail.count.count_number || detail.count.id)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      setMessage(`Planilla Excel ciega descargada (${String(detail.count.count_number)}).`);
      await loadCounts(Number(detail.count.id));
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
      counterName: String(detail.count.counter_name || 'Sin asignar'),
      items: detail.items.map((i) => ({
        sku: i.sku,
        description: i.description,
        unitOfMeasure: i.unit_of_measure,
      })),
    });
    await loadCounts(Number(detail.count.id));
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
          isNotCounted: false,
          notCountedReason: '',
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

  const handleDownloadAttachment = async (attId: number, originalName: string) => {
    setError(null);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/attachments/${attId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'No se pudo descargar el adjunto');
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

  const incompleteItems = detail
    ? detail.items
        .map((it) => {
          const entry = inputs[it.id] || {
            bulkQty: '',
            looseQty: '',
            isNotCounted: false,
            notCountedReason: '',
            obs: '',
          };
          if (entry.isNotCounted) {
            return {
              id: it.id,
              sku: it.sku,
              missingBulk: false,
              missingLoose: false,
              missingReason: entry.notCountedReason.trim() === '',
            };
          }
          const bulkProvided = entry.bulkQty.trim() !== '';
          const looseProvided = entry.looseQty.trim() !== '';
          const bulkValidOpt = isValidOptionalQty(entry.bulkQty);
          const looseValidOpt = isValidOptionalQty(entry.looseQty);
          const missingAnyQty = !bulkProvided && !looseProvided;
          const invalidBulk = !bulkValidOpt;
          const invalidLoose = !looseValidOpt;
          return {
            id: it.id,
            sku: it.sku,
            missingAnyQty,
            invalidBulk,
            invalidLoose,
            missingReason: false,
          };
        })
        .filter((x) => x.missingAnyQty || x.invalidBulk || x.invalidLoose || x.missingReason)
    : [];

  const totalAttachmentsCount = detail
    ? (detail.sheetAttachments?.length || 0) +
      detail.items.reduce((sum, it) => sum + (it.attachments?.length || 0), 0)
    : 0;

  const hasWarehouseSignature = Boolean(
    detail && String(detail.count.warehouse_signature_name || '').trim()
  );
  const hasCounterSignature = counterSig.trim().length > 0;
  const hasGeneralObservations = generalObservations.trim().length > 0;
  const isExecutionStageForPresent = Boolean(
    detail && detail.count.status === CountStatus.EJECUCION
  );

  const handleSaveOrPresent = async (presentForApproval: boolean) => {
    if (!detail) return;
    setError(null);
    setMessage(null);

    if (presentForApproval) {
      setValidationAttempted(true);
      if (!isExecutionStageForPresent) {
        setError(
          'El conteo debe encontrarse en estado EJECUCIÓN para poder presentarlo para revisión.'
        );
        return;
      }
      if (incompleteItems.length > 0) {
        const previewSkus = incompleteItems
          .slice(0, 4)
          .map((x) => {
            if (x.missingReason) return `${x.sku} (Justificación de no conteo)`;
            if (x.missingAnyQty) return `${x.sku} (Ingrese cantidad, puede ser 0)`;
            const cols = [
              x.invalidBulk ? 'Unidades/Bultos inválidas' : '',
              x.invalidLoose ? 'Unidades Sueltas inválidas' : '',
            ]
              .filter(Boolean)
              .join(' y ');
            return `${x.sku} (${cols})`;
          })
          .join(', ');
        setError(
          `No se puede presentar el conteo: todos los artículos deben tener resultado físico (puede ser 0) o justificación de no conteo. Pendientes (${incompleteItems.length}): ${previewSkus}${
            incompleteItems.length > 4 ? '...' : ''
          }.`
        );
        return;
      }
      if (!hasCounterSignature) {
        setError('Debe ingresar la firma o responsabilidad digital del contador.');
        return;
      }
      if (!hasWarehouseSignature) {
        setError(
          'Falta la firma/conformidad del Responsable de Depósito antes de presentar el conteo.'
        );
        return;
      }
      if (!hasGeneralObservations) {
        setError('Debe completar las observaciones generales obligatorias del conteo.');
        return;
      }
    }

    // Validate numeric inputs when provided on non-skipped items
    for (const it of detail.items) {
      const entry = inputs[it.id] || {
        bulkQty: '',
        looseQty: '',
        isNotCounted: false,
        notCountedReason: '',
        obs: '',
      };
      if (entry.isNotCounted) continue;
      if (!isValidOptionalQty(entry.bulkQty)) {
        setValidationAttempted(true);
        setError(
          `El valor de "Unidades / Bultos" en ${it.sku} debe ser un número válido mayor o igual a 0.`
        );
        return;
      }
      if (!isValidOptionalQty(entry.looseQty)) {
        setValidationAttempted(true);
        setError(
          `El valor de "Unidades Sueltas" en ${it.sku} debe ser un número válido mayor o igual a 0.`
        );
        return;
      }
    }

    setSaving(true);
    try {
      const payloadItems = detail.items.map((it) => {
        const entry = inputs[it.id] || {
          bulkQty: '',
          looseQty: '',
          isNotCounted: false,
          notCountedReason: '',
          obs: '',
        };
        if (entry.isNotCounted) {
          return {
            itemId: it.id,
            isNotCounted: true,
            notCountedReason: entry.notCountedReason.trim(),
            bulkQty: null,
            looseQty: null,
            countedQty: null,
            observations: entry.obs ?? '',
          };
        }
        const hasAny = entry.bulkQty.trim() !== '' || entry.looseQty.trim() !== '';
        const bulk = entry.bulkQty.trim() === '' ? (hasAny ? 0 : null) : Number(entry.bulkQty);
        const loose = entry.looseQty.trim() === '' ? (hasAny ? 0 : null) : Number(entry.looseQty);
        const countedQty =
          hasAny && bulk !== null && loose !== null
            ? Math.round((bulk + loose) * 10000) / 10000
            : null;
        return {
          itemId: it.id,
          isNotCounted: false,
          notCountedReason: '',
          bulkQty: bulk,
          looseQty: loose,
          countedQty,
          observations: entry.obs ?? '',
        };
      });

      const endpoint = presentForApproval
        ? `/api/counts/${detail.count.id}/present`
        : `/api/counts/${detail.count.id}/submit-results`;

      await apiFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          items: payloadItems,
          counterSignatureName: counterSig.trim(),
          generalObservations: generalObservations.trim(),
          submitForReview: presentForApproval,
        }),
      });

      setValidationAttempted(false);
      setMessage(
        presentForApproval
          ? totalAttachmentsCount === 0
            ? 'Conteo entregado para revisión. Aviso: quedó pendiente adjuntar la foto del conteo firmado como respaldo completo.'
            : 'Conteo entregado para revisión y enviado al Jefe de Control de Stock.'
          : 'Avance guardado correctamente.'
      );
      await loadCounts(Number(detail.count.id));
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
      await loadCounts(Number(detail.count.id));
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const canCounterEdit = Boolean(
    detail &&
      (currentUser.role === UserRole.CONTADOR || currentUser.role === UserRole.JEFE_STOCK) &&
      detail.count.status === CountStatus.EJECUCION
  );

  const canUploadSheet = Boolean(
    detail &&
      currentUser.role !== UserRole.AUDITORIA_DIRECCION &&
      detail.count.status !== CountStatus.RECHAZADO &&
      (currentUser.role === UserRole.JEFE_STOCK || detail.count.status === CountStatus.EJECUCION)
  );

  const detailMeta = detail ? getCountStatusMeta(String(detail.count.status)) : null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">
          Ejecución de Conteos Ciegos y Presentación
        </h2>
        <p className="text-sm text-slate-600 mt-0.5">
          Planillas ciegas imprimibles en PDF, carga manual o Excel, justificación de no conteo, documentación respaldatoria y presentación formal para aprobación.
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
            Conteos Disponibles ({counts.length})
          </div>
          {loading ? (
            <div className="p-6 text-xs text-slate-500 text-center">Cargando...</div>
          ) : counts.length === 0 ? (
            <div className="p-6 text-xs text-slate-500 text-center">
              No hay conteos asignados para su perfil.
            </div>
          ) : (
            <div className="divide-y divide-slate-100 max-h-[640px] overflow-y-auto">
              {counts.map((c) => {
                const meta = getCountStatusMeta(c.status);
                return (
                  <button
                    key={c.id}
                    onClick={() => openCount(c.id)}
                    className={`w-full text-left p-3.5 transition-colors hover:bg-slate-50 ${
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
                      {c.counted_items_count}/{c.items_count} ítems
                    </div>
                    {Number(c.attachments_count || 0) === 0 &&
                      ([CountStatus.ENTREGADO, CountStatus.APROBADO] as CountStatus[]).includes(
                        c.status
                      ) && (
                        <div className="text-[10px] font-semibold text-amber-700 mt-1">
                          Pendiente foto firmada de respaldo
                        </div>
                      )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Right Detail */}
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5 space-y-5">
          {!detail ? (
            <div className="py-16 text-center text-sm text-slate-500">
              <ClipboardCheck className="w-8 h-8 text-slate-400 mx-auto mb-2" />
              Seleccione un conteo de la lista para imprimir su planilla ciega, iniciar ejecución, cargar cantidades o presentarlo a aprobación.
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
                    <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-slate-500">
                      <span>
                        MercoMat · {String(detail.count.count_number)} · ID{' '}
                        {String(detail.count.document_uid)}
                      </span>
                      {detailMeta && (
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 font-sans text-[11px] font-medium border rounded ${detailMeta.surfaceClass} ${detailMeta.textClass}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${detailMeta.dotClass}`} />
                          {detailMeta.label}
                        </span>
                      )}
                    </div>
                    <h3 className="text-lg font-bold text-slate-900 mt-0.5">
                      {String(detail.count.location_name)}
                    </h3>
                    <div className="text-xs text-slate-600 mt-0.5">
                      Fecha programada:{' '}
                      <span className="font-mono">{String(detail.count.scheduled_date)}</span> ·
                      Contador: {String(detail.count.counter_name || 'Sin asignar')}
                      {Boolean(detail.count.blind_printed_at) && (
                        <>
                          {' '}
                          ·{' '}
                          <span className="text-emerald-700 font-medium">
                            Planilla validada ({String(detail.count.blind_printed_at).slice(0, 16)})
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {detail.count.status === CountStatus.RECHAZADO &&
                    (currentUser.role === UserRole.CONTADOR ||
                      currentUser.role === UserRole.JEFE_STOCK) && (
                      <button
                        type="button"
                        onClick={handleReopenCount}
                        disabled={saving}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-amber-700 text-white rounded-lg hover:bg-amber-800 whitespace-nowrap"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Reabrir en Ejecución
                      </button>
                    )}

                  {detail.count.status === CountStatus.EJECUCION && (
                    <button
                      type="button"
                      onClick={handleDownloadExcel}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-700 text-white rounded-lg hover:bg-emerald-800 whitespace-nowrap"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Descargar Planilla Excel
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={handlePrintBlindPdf}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#8e0d0d] text-white rounded-lg hover:bg-[#6e0909] whitespace-nowrap"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    Imprimir Planilla Ciega (PDF)
                  </button>

                  {canCounterEdit && (
                    <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap">
                      <FileSpreadsheet className="w-3.5 h-3.5" />
                      Importar Excel
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

              {detail.count.status === CountStatus.RECHAZADO && (
                <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-900 space-y-1.5">
                  <div className="font-bold flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4 text-red-700 shrink-0" />
                    Conteo Rechazado por Control de Stock — Haga clic en &quot;Reabrir en Ejecución&quot; para corregir y volver a entregar
                  </div>
                  <div>
                    <strong>Motivo del rechazo:</strong>{' '}
                    {String(detail.count.rejection_reason || detail.count.chief_notes || 'Sin especificar')}
                  </div>
                  {detail.submissions.length > 0 && (
                    <div className="text-[11px] text-red-800">
                      Versión anterior conservada en historial: v{detail.submissions[0].version_number} (
                      {detail.submissions[0].created_at.slice(0, 16)}). Al reabrir en EJECUCIÓN podrá corregir los datos y entregar la versión v{detail.submissions[0].version_number + 1}.
                    </div>
                  )}
                </div>
              )}

              {detail.isBlindRestricted && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-blue-700 shrink-0" />
                  <span>
                    <strong>Modo Conteo Ciego Activo:</strong> Las existencias teóricas del ERP y posibles diferencias permanecen ocultas hasta presentar el relevamiento físico para aprobación.
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
                        Unidades / Bultos <span className="text-[10px] font-normal text-slate-400">(0 o más)</span>
                      </th>
                      <th className="py-2 px-2.5 text-right whitespace-nowrap">
                        Unidades Sueltas <span className="text-[10px] font-normal text-slate-400">(opc.)</span>
                      </th>
                      <th className="py-2 px-2.5 text-right whitespace-nowrap">
                        {Boolean(detail.count.rejected_at) || (detail.submissions?.length || 0) > 0
                          ? 'Total Corregido'
                          : 'Total Físico'}
                      </th>
                      {!detail.isBlindRestricted && (
                        <>
                          <th className="py-2 px-2.5 text-right">Diferencia</th>
                          <th className="py-2 px-2.5">Resultado</th>
                        </>
                      )}
                      <th className="py-2 px-2.5">Observaciones / Estado / Foto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.items.map((it) => {
                      const entry = inputs[it.id] || {
                        bulkQty: '',
                        looseQty: '',
                        isNotCounted: false,
                        notCountedReason: '',
                        obs: '',
                      };
                      const hasAnyQty =
                        entry.bulkQty.trim() !== '' || entry.looseQty.trim() !== '';
                      const bulkValid =
                        entry.isNotCounted ||
                        (isValidOptionalQty(entry.bulkQty) && hasAnyQty);
                      const looseValid = entry.isNotCounted || isValidOptionalQty(entry.looseQty);
                      const reasonValid =
                        !entry.isNotCounted || entry.notCountedReason.trim().length > 0;
                      const bulkNum = entry.bulkQty.trim() === '' ? 0 : Number(entry.bulkQty);
                      const looseNum = entry.looseQty.trim() === '' ? 0 : Number(entry.looseQty);
                      const rowTotal = entry.isNotCounted
                        ? null
                        : hasAnyQty &&
                            isValidOptionalQty(entry.bulkQty) &&
                            isValidOptionalQty(entry.looseQty)
                          ? Math.round((bulkNum + looseNum) * 10000) / 10000
                          : null;
                      const isRecount =
                        Boolean(detail.count.rejected_at) || (detail.submissions?.length || 0) > 0;
                      const displayBulk = isRecount ? it.recount_bulk_qty : it.bulk_qty;
                      const displayLoose = isRecount ? it.recount_loose_qty : it.loose_qty;

                      return (
                        <React.Fragment key={it.id}>
                          <tr
                            className={`border-b border-slate-100 ${
                              entry.isNotCounted ? 'bg-slate-50/80' : ''
                            }`}
                          >
                            <td className="py-2 px-2.5 font-mono font-semibold text-slate-900 align-top">
                              {it.sku}
                            </td>
                            <td className="py-2 px-2.5 align-top">
                              <div className="font-medium text-slate-900">{it.description}</div>
                              <div className="text-[11px] text-slate-500">{it.unit_of_measure}</div>
                              {it.recount_requested_reason && (
                                <div className="text-[11px] text-red-700 mt-0.5 font-medium">
                                  Motivo corrección: {it.recount_requested_reason}
                                </div>
                              )}
                            </td>
                            {!detail.isBlindRestricted && (
                              <>
                                <td className="py-2 px-2.5 text-right font-mono tabular-nums align-top">
                                  {it.snapshot_erp_stock}
                                </td>
                                <td className="py-2 px-2.5 text-right font-mono tabular-nums text-slate-500 align-top">
                                  {it.snapshot_committed_stock}
                                </td>
                              </>
                            )}
                            <td className="py-2 px-2.5 text-right align-top">
                              {canCounterEdit ? (
                                entry.isNotCounted ? (
                                  <span className="text-[11px] font-medium text-slate-500 italic">
                                    No contado
                                  </span>
                                ) : (
                                  <div className="inline-flex flex-col items-end">
                                    <input
                                      type="number"
                                      min={0}
                                      step="any"
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
                                        Ingrese 0 o cant.
                                      </span>
                                    )}
                                  </div>
                                )
                              ) : (
                                <span className="font-mono tabular-nums text-slate-700">
                                  {Number(it.is_not_counted || 0) === 1
                                    ? 'No contado'
                                    : (displayBulk ?? '—')}
                                </span>
                              )}
                            </td>
                            <td className="py-2 px-2.5 text-right align-top">
                              {canCounterEdit ? (
                                entry.isNotCounted ? (
                                  <span className="text-[11px] text-slate-400">—</span>
                                ) : (
                                  <div className="inline-flex flex-col items-end">
                                    <input
                                      type="number"
                                      min={0}
                                      step="any"
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
                                          ? 'border-red-500 bg-red-50/70 text-red-900'
                                          : 'border-slate-300 bg-white'
                                      }`}
                                    />
                                    {!looseValid && (
                                      <span className="text-[10px] text-red-600 mt-0.5">
                                        Inválido
                                      </span>
                                    )}
                                  </div>
                                )
                              ) : (
                                <span className="font-mono tabular-nums text-slate-700">
                                  {Number(it.is_not_counted || 0) === 1
                                    ? '—'
                                    : (displayLoose ?? '—')}
                                </span>
                              )}
                            </td>
                            <td className="py-2 px-2.5 text-right align-top">
                              {canCounterEdit ? (
                                entry.isNotCounted ? (
                                  <span className="text-[11px] font-medium text-amber-800">
                                    Justificado
                                  </span>
                                ) : (
                                  <span
                                    className={`font-mono font-semibold tabular-nums ${
                                      rowTotal !== null
                                        ? 'text-slate-900'
                                        : 'text-amber-700 text-[11px]'
                                    }`}
                                  >
                                    {rowTotal !== null ? rowTotal : 'Incompleto'}
                                  </span>
                                )
                              ) : (
                                <span className="font-mono font-semibold tabular-nums">
                                  {Number(it.is_not_counted || 0) === 1
                                    ? 'No contado'
                                    : (it.final_counted_qty ?? '—')}
                                </span>
                              )}
                            </td>
                            {!detail.isBlindRestricted && (
                              <>
                                <td
                                  className={`py-2 px-2.5 text-right font-mono font-bold tabular-nums align-top ${
                                    Number(it.is_not_counted || 0) === 1
                                      ? 'text-slate-500'
                                      : (it.difference || 0) < 0
                                        ? 'text-red-700'
                                        : (it.difference || 0) > 0
                                          ? 'text-amber-700'
                                          : 'text-emerald-700'
                                  }`}
                                >
                                  {Number(it.is_not_counted || 0) === 1
                                    ? 'N/C'
                                    : it.difference !== null
                                      ? `${it.difference > 0 ? '+' : ''}${it.difference}`
                                      : '—'}
                                </td>
                                <td className="py-2 px-2.5 font-medium align-top">
                                  {Number(it.is_not_counted || 0) === 1
                                    ? 'NO CONTADO'
                                    : it.reconciliation_result || 'Pendiente'}
                                </td>
                              </>
                            )}
                            <td className="py-2 px-2.5 space-y-1.5 align-top min-w-[200px]">
                              {canCounterEdit ? (
                                <>
                                  <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-700 cursor-pointer select-none">
                                    <input
                                      type="checkbox"
                                      checked={entry.isNotCounted}
                                      onChange={(e) =>
                                        setInputs({
                                          ...inputs,
                                          [it.id]: {
                                            ...entry,
                                            isNotCounted: e.target.checked,
                                          },
                                        })
                                      }
                                      className="rounded border-slate-300"
                                    />
                                    Marcar como No contado
                                  </label>

                                  {entry.isNotCounted && (
                                    <div>
                                      <input
                                        type="text"
                                        value={entry.notCountedReason}
                                        onChange={(e) =>
                                          setInputs({
                                            ...inputs,
                                            [it.id]: {
                                              ...entry,
                                              notCountedReason: e.target.value,
                                            },
                                          })
                                        }
                                        placeholder="Motivo obligatorio de no conteo *"
                                        className={`w-full px-2 py-1 border rounded text-xs ${
                                          !reasonValid && validationAttempted
                                            ? 'border-red-500 bg-red-50/70'
                                            : 'border-amber-400 bg-amber-50/40'
                                        }`}
                                      />
                                      {validationAttempted && !reasonValid && (
                                        <span className="text-[10px] text-red-600 block mt-0.5">
                                          Justificación requerida
                                        </span>
                                      )}
                                    </div>
                                  )}

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
                                    placeholder="Obs. del ítem..."
                                    className="w-full px-2 py-1 border border-slate-300 rounded text-xs"
                                  />
                                </>
                              ) : (
                                <div className="space-y-0.5 text-slate-600">
                                  {Number(it.is_not_counted || 0) === 1 && (
                                    <div className="text-[11px] text-amber-800 font-medium">
                                      Justificación: {it.not_counted_reason || '—'}
                                    </div>
                                  )}
                                  <div>{it.counter_observations || '—'}</div>
                                </div>
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
                                  <button
                                    key={att.id}
                                    type="button"
                                    onClick={() =>
                                      handleDownloadAttachment(att.id, att.original_name)
                                    }
                                    className="inline-flex items-center gap-1 text-[11px] text-slate-700 hover:text-[#8e0d0d] hover:underline"
                                    title="Descargar adjunto"
                                  >
                                    <Paperclip className="w-3 h-3" />
                                    {att.original_name}
                                  </button>
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

              {/* Count-level Supporting Documentation */}
              <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-2.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-bold text-slate-900">
                      Planilla Firmada / Documentación Respaldatoria ({totalAttachmentsCount} adjunto(s))
                    </div>
                    <div className="text-[11px] text-slate-500">
                      Puede presentar el conteo sin la foto firmada, pero quedará con aviso pendiente de respaldo para el cierre documental.
                    </div>
                  </div>
                  {canUploadSheet && (
                    <label className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-300 rounded-lg cursor-pointer hover:bg-slate-100 font-medium text-slate-800 whitespace-nowrap">
                      <Upload className="w-3.5 h-3.5" />
                      Subir Planilla Firmada / Archivo
                      <input
                        type="file"
                        accept="image/*,.pdf"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleUploadAttachment('COUNT_SHEET', Number(detail.count.id), f);
                        }}
                        className="hidden"
                      />
                    </label>
                  )}
                </div>

                {totalAttachmentsCount === 0 && detail.count.status !== CountStatus.APROBADO && (
                  <div className="p-2.5 bg-amber-50 border border-amber-300 rounded-lg text-[11px] text-amber-900 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                    <div>
                      <strong>
                        {canCounterEdit
                          ? 'Advertencia: Sin foto de planilla firmada adjunta.'
                          : 'Aviso de pendiente de respaldo:'}
                      </strong>{' '}
                      {canCounterEdit
                        ? 'Puede entregar el conteo igualmente, pero quedará con aviso pendiente de documentación respaldatoria.'
                        : 'El conteo fue entregado sin la foto de la planilla firmada.'}
                    </div>
                  </div>
                )}

                {detail.sheetAttachments.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {detail.sheetAttachments.map((att) => (
                      <button
                        key={att.id}
                        type="button"
                        onClick={() => handleDownloadAttachment(att.id, att.original_name)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white border border-slate-200 rounded text-[11px] font-medium text-slate-700 hover:border-[#8e0d0d] hover:text-[#8e0d0d]"
                      >
                        <Download className="w-3 h-3" />
                        {att.original_name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Counter submission / presentation panel */}
              {canCounterEdit && (
                <div className="pt-4 border-t border-slate-200 space-y-4">
                  <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-2 text-xs">
                    <div className="font-bold text-slate-900">
                      Checklist para Entrega Formal a Revisión
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11px]">
                      <div className={isExecutionStageForPresent ? 'text-emerald-700' : 'text-amber-700'}>
                        {isExecutionStageForPresent ? '✓' : '○'} Conteo en EJECUCIÓN (
                        {isExecutionStageForPresent ? 'Listo para entrega' : 'Reabrir para editar'})
                      </div>
                      <div className={incompleteItems.length === 0 ? 'text-emerald-700' : 'text-amber-700'}>
                        {incompleteItems.length === 0 ? '✓' : '○'} Artículos completos (0 o más) o justificados (
                        {detail.items.length - incompleteItems.length}/{detail.items.length})
                      </div>
                      <div className={hasCounterSignature ? 'text-emerald-700' : 'text-amber-700'}>
                        {hasCounterSignature ? '✓' : '○'} Firma digital del responsable de conteo
                      </div>
                      <div className={hasWarehouseSignature ? 'text-emerald-700' : 'text-amber-700'}>
                        {hasWarehouseSignature ? '✓' : '○'} Conformidad del Responsable de Depósito
                      </div>
                      <div className={hasGeneralObservations ? 'text-emerald-700' : 'text-amber-700'}>
                        {hasGeneralObservations ? '✓' : '○'} Observaciones generales del conteo
                      </div>
                      <div className={totalAttachmentsCount > 0 ? 'text-emerald-700' : 'text-amber-700'}>
                        {totalAttachmentsCount > 0
                          ? `✓ Foto / planilla firmada adjunta (${totalAttachmentsCount})`
                          : '⚠ Sin foto firmada (no bloquea la entrega; quedará aviso pendiente)'}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Observaciones Generales del Conteo <span className="text-red-600">*</span>
                      </label>
                      <textarea
                        rows={2}
                        value={generalObservations}
                        onChange={(e) => setGeneralObservations(e.target.value)}
                        placeholder="Detalle condiciones del depósito, hallazgos relevantes, orden de estanterías o incidencias..."
                        className={`w-full px-3 py-2 text-xs border rounded-lg ${
                          validationAttempted && !hasGeneralObservations
                            ? 'border-red-500 bg-red-50/60'
                            : 'border-slate-300 bg-white'
                        }`}
                      />
                    </div>

                    <div className="flex flex-wrap items-end justify-between gap-4">
                      <div className="w-full sm:w-64">
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Firma Digital Responsable de Conteo <span className="text-red-600">*</span>
                        </label>
                        <input
                          type="text"
                          value={counterSig}
                          onChange={(e) => setCounterSig(e.target.value)}
                          className={`w-full px-3 py-1.5 text-xs border rounded-lg ${
                            validationAttempted && !hasCounterSignature
                              ? 'border-red-500 bg-red-50/60'
                              : 'border-slate-300 bg-white'
                          }`}
                        />
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleSaveOrPresent(false)}
                          disabled={saving}
                          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 whitespace-nowrap"
                        >
                          <Save className="w-3.5 h-3.5" />
                          Guardar Avance
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSaveOrPresent(true)}
                          disabled={saving}
                          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-[#8e0d0d] text-white rounded-lg hover:bg-[#6e0909] disabled:opacity-50 whitespace-nowrap"
                        >
                          <Send className="w-3.5 h-3.5" />
                          ENTREGAR CONTEO PARA REVISIÓN
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Read-only summary banner when already delivered/approved/rejected */}
              {!canCounterEdit && String(detail.count.counter_general_notes || '').trim() !== '' && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700">
                  <span className="font-semibold text-slate-900">Observaciones del contador:</span>{' '}
                  {String(detail.count.counter_general_notes)}
                </div>
              )}

              {/* Warehouse Manager Signature */}
              {(currentUser.role === UserRole.RESPONSABLE_DEPOSITO ||
                currentUser.role === UserRole.JEFE_STOCK) &&
                detail.count.status === CountStatus.EJECUCION && (
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
