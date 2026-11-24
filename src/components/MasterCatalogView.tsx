import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  History,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { apiDownload, apiFetch, getAuthToken } from '../lib/api';
import { AuthUser, ExcelColumnMapping, UserRole } from '../types/erp';

interface BalanceItem {
  balance_id: number;
  product_id: number;
  sku: string;
  description: string;
  alias: string;
  family: string;
  brand: string;
  unit_of_measure: string;
  cost_price: number | null;
  sale_price: number | null;
  criticality_level: string;
  location_id: number;
  location_name: string;
  erp_physical_stock: number;
  committed_stock: number;
  review_stock: number;
  damaged_stock: number;
  pos_pending_sync: number;
  available_stock: number;
  last_erp_updated_at: string | null;
  last_counted_at: string | null;
}

interface ConsolidatedItem {
  product_id: number;
  sku: string;
  description: string;
  alias: string;
  family: string;
  brand: string;
  unit_of_measure: string;
  cost_price: number | null;
  sale_price: number | null;
  locations_count: number;
  total_erp_physical: number;
  total_committed: number;
  total_review: number;
  total_damaged: number;
  total_pos_pending: number;
  total_available: number;
  last_erp_sync_at: string | null;
}

interface ValidationPreview {
  totalRows: number;
  validRowsCount: number;
  globalMasterRowsCount: number;
  newProductsCount: number;
  existingProductsCount: number;
  duplicateSkuLocationPairs: number;
  unmappedLocations: string[];
  issues: Array<{
    rowNumber: number;
    sku: string;
    severity: 'ERROR' | 'ADVERTENCIA';
    code: string;
    message: string;
  }>;
  sampleRows: Array<{
    rowNumber: number;
    sku: string;
    description: string;
    family: string;
    locationName: string;
    matchedLocationId: number | null;
    isGlobalMaster: boolean;
    erpStock: number;
    committedStock: number;
    availableCalculated: number;
    isNewProduct: boolean;
  }>;
}

interface ImportBatch {
  id: number;
  filename: string;
  cutoff_timestamp: string;
  uploaded_by_name: string;
  total_rows: number;
  inserted_products: number;
  updated_balances: number;
  warnings_count: number;
  created_at: string;
}

export const MasterCatalogView: React.FC<{ currentUser: AuthUser }> = ({ currentUser }) => {
  const [viewMode, setViewMode] = useState<'by_location' | 'consolidated' | 'batches'>('by_location');
  const [search, setSearch] = useState('');
  const [locationId, setLocationId] = useState('');
  const [locations, setLocations] = useState<Array<{ id: number; name: string }>>([]);
  const [items, setItems] = useState<BalanceItem[]>([]);
  const [consolidated, setConsolidated] = useState<ConsolidatedItem[]>([]);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingBatches, setLoadingBatches] = useState(false);
  const [deletingBatchId, setDeletingBatchId] = useState<number | null>(null);
  const [batchToDelete, setBatchToDelete] = useState<ImportBatch | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Excel Wizard state
  const [showImportModal, setShowImportModal] = useState(false);
  const [importStep, setImportStep] = useState<1 | 2 | 3>(1);
  const [importFileName, setImportFileName] = useState('');
  const [excelHeaders, setExcelHeaders] = useState<string[]>([]);
  const [excelRows, setExcelRows] = useState<Record<string, unknown>[]>([]);
  const [cutoffTimestamp, setCutoffTimestamp] = useState(new Date().toISOString().slice(0, 16));
  const [mapping, setMapping] = useState<ExcelColumnMapping>({
    sku: '',
    description: '',
    erpStock: '',
    location: '',
  });
  const [validation, setValidation] = useState<ValidationPreview | null>(null);
  const [importing, setImporting] = useState(false);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  // Stock bucket adjustment modal (review / damaged)
  const [bucketTarget, setBucketTarget] = useState<BalanceItem | null>(null);
  const [bucketForm, setBucketForm] = useState({ reviewStock: 0, damagedStock: 0, reason: '' });

  const loadBatches = async () => {
    if (currentUser.role !== UserRole.JEFE_STOCK) return;
    setLoadingBatches(true);
    try {
      const bRes = await apiFetch<{ batches: ImportBatch[] }>('/api/inventory/batches');
      setBatches(bRes.batches);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoadingBatches(false);
    }
  };

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (search) qs.set('search', search);
      if (locationId) qs.set('locationId', locationId);

      const [invRes, locRes] = await Promise.all([
        apiFetch<{ items: BalanceItem[]; consolidated: ConsolidatedItem[] }>(`/api/inventory?${qs}`),
        apiFetch<{ locations: Array<{ id: number; name: string }> }>('/api/locations'),
      ]);
      setItems(invRes.items);
      setConsolidated(invRes.consolidated);
      setLocations(locRes.locations);

      if (invRes.items.length === 0 && invRes.consolidated.length > 0 && !locationId) {
        setViewMode((prev) => (prev === 'by_location' ? 'consolidated' : prev));
      }

      if (currentUser.role === UserRole.JEFE_STOCK) {
        const bRes = await apiFetch<{ batches: ImportBatch[] }>('/api/inventory/batches');
        setBatches(bRes.batches);
      }
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [locationId]);

  const handleConfirmDeleteBatch = async () => {
    if (!batchToDelete) return;
    setError(null);
    setDeletingBatchId(batchToDelete.id);
    try {
      await apiFetch<{ ok: boolean }>(`/api/inventory/batches/${batchToDelete.id}`, {
        method: 'DELETE',
      });
      setImportSuccess(
        `Registro de importación #${batchToDelete.id} ("${batchToDelete.filename}") eliminado. Los artículos y existencias importados se conservan intactos.`
      );
      setBatchToDelete(null);
      await loadBatches();
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setDeletingBatchId(null);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const token = getAuthToken();
      const res = await fetch('/api/inventory/import/preview', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error leyendo Excel');
      setImportFileName(data.filename);
      setExcelHeaders(data.headers);
      setExcelRows(data.rows);
      setMapping({
        sku: data.suggestedMapping.sku || '',
        description: data.suggestedMapping.description || '',
        alias: data.suggestedMapping.alias || '',
        family: data.suggestedMapping.family || '',
        brand: data.suggestedMapping.brand || '',
        unitOfMeasure: data.suggestedMapping.unitOfMeasure || '',
        erpStock: data.suggestedMapping.erpStock || '',
        location: data.suggestedMapping.location || '',
        costPrice: data.suggestedMapping.costPrice || '',
        salePrice: data.suggestedMapping.salePrice || '',
        committedStock: data.suggestedMapping.committedStock || '',
        criticality: data.suggestedMapping.criticality || '',
      });
      setImportStep(2);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const handleValidateMapping = async () => {
    setError(null);
    setImporting(true);
    try {
      const res = await apiFetch<{ preview: ValidationPreview }>('/api/inventory/import/validate', {
        method: 'POST',
        body: JSON.stringify({ rows: excelRows, mapping }),
      });
      setValidation(res.preview);
      setImportStep(3);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const handleCommitImport = async () => {
    setError(null);
    setImporting(true);
    try {
      const res = await apiFetch<{
        batchId: number;
        insertedProducts: number;
        updatedProducts: number;
        updatedBalances: number;
        skippedErrors: number;
        warningsCount: number;
      }>('/api/inventory/import/commit', {
        method: 'POST',
        body: JSON.stringify({
          filename: importFileName,
          cutoffTimestamp: new Date(cutoffTimestamp).toISOString(),
          rows: excelRows,
          mapping,
        }),
      });
      setShowImportModal(false);
      setImportStep(1);
      setImportSuccess(
        `Lote #${res.batchId} importado: ${res.insertedProducts} artículo(s) nuevo(s), ${res.updatedProducts} artículo(s) actualizado(s), ${res.updatedBalances} existencia(s) por depósito actualizada(s), ${res.skippedErrors} fila(s) omitida(s).`
      );
      await loadData();
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const handleSaveBuckets = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bucketTarget) return;
    try {
      await apiFetch('/api/inventory/balance-buckets', {
        method: 'PATCH',
        body: JSON.stringify({
          productId: bucketTarget.product_id,
          locationId: bucketTarget.location_id,
          reviewStock: bucketForm.reviewStock,
          damagedStock: bucketForm.damagedStock,
          reason: bucketForm.reason,
        }),
      });
      setBucketTarget(null);
      await loadData();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const mapFieldLabels: Array<{ key: keyof ExcelColumnMapping; label: string; required?: boolean }> = [
    { key: 'sku', label: 'Código de artículo', required: true },
    { key: 'description', label: 'Descripción', required: true },
    { key: 'family', label: 'Familia / Rubro' },
    { key: 'brand', label: 'Marca' },
    { key: 'unitOfMeasure', label: 'Unidad de medida' },
    { key: 'location', label: 'Depósito / Ubicación (opcional)' },
    { key: 'erpStock', label: 'Existencia ERP (opcional)' },
    { key: 'committedStock', label: 'Stock comprometido' },
    { key: 'costPrice', label: 'Costo unitario' },
    { key: 'salePrice', label: 'Precio de venta' },
    { key: 'alias', label: 'Alias / Cód. alternativo' },
    { key: 'criticality', label: 'Criticidad comercial' },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Almacén Maestro de Inventarios</h2>
          <p className="text-sm text-slate-600 mt-0.5">
            Base centralizada con distinción de stock físico ERP, comprometido, en revisión, rotura y disponible.
          </p>
        </div>
        {currentUser.role === UserRole.JEFE_STOCK && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() =>
                apiDownload('/api/inventory/template', 'Plantilla_Almacen_Maestro_ERP.xlsx')
              }
              className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              Plantilla Excel
            </button>
            <button
              onClick={() =>
                apiDownload('/api/inventory/export', 'Almacen_Maestro_Consolidado.xlsx')
              }
              className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              Exportar Excel
            </button>
            <button
              onClick={() => {
                setViewMode('batches');
                loadBatches();
              }}
              className={`inline-flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg border whitespace-nowrap transition-colors ${
                viewMode === 'batches'
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
            >
              <History className="w-3.5 h-3.5" />
              Historial Importaciones ({batches.length})
            </button>
            <button
              onClick={() => {
                setImportStep(1);
                setValidation(null);
                setShowImportModal(true);
              }}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-[#8e0d0d] hover:bg-[#6e0909] rounded-lg whitespace-nowrap"
            >
              <Upload className="w-3.5 h-3.5" />
              Importar Excel ERP
            </button>
          </div>
        )}
      </div>

      {importSuccess && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800 flex items-center justify-between">
          <span className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="w-4 h-4" />
            {importSuccess}
          </span>
          <button onClick={() => setImportSuccess(null)} className="text-emerald-700 hover:underline">
            Cerrar
          </button>
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
          <button
            onClick={() => setViewMode('by_location')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
              viewMode === 'by_location' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Existencias por Ubicación ({items.length})
          </button>
          <button
            onClick={() => setViewMode('consolidated')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
              viewMode === 'consolidated' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Consolidado por Artículo ({consolidated.length})
          </button>
          {currentUser.role === UserRole.JEFE_STOCK && (
            <button
              onClick={() => {
                setViewMode('batches');
                loadBatches();
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap inline-flex items-center gap-1.5 ${
                viewMode === 'batches' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              <History className="w-3.5 h-3.5" />
              Historial Importaciones ({batches.length})
            </button>
          )}
        </div>

        {viewMode !== 'batches' && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadData()}
                placeholder="Buscar código, descripción, alias..."
                className="pl-9 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg w-64"
              />
            </div>
            {viewMode === 'by_location' && (
              <select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
              >
                <option value="">Todas las ubicaciones</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={loadData}
              className="px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800"
            >
              Filtrar
            </button>
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">Cargando Almacén Maestro...</div>
        ) : items.length === 0 && consolidated.length === 0 && viewMode !== 'batches' ? (
          <div className="p-12 text-center max-w-lg mx-auto space-y-3">
            <FileSpreadsheet className="w-10 h-10 text-slate-400 mx-auto" />
            <h3 className="text-base font-semibold text-slate-900">
              Almacén Maestro sin artículos importados
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              No se muestran datos ficticios. Importe el archivo Excel descargado del ERP vigente
              (o descargue la plantilla oficial) para cargar los artículos y sus existencias por
              depósito.
            </p>
            {currentUser.role === UserRole.JEFE_STOCK && (
              <button
                onClick={() => {
                  setImportStep(1);
                  setShowImportModal(true);
                }}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
              >
                <Upload className="w-3.5 h-3.5" />
                Importar Excel del ERP
              </button>
            )}
          </div>
        ) : viewMode === 'by_location' ? (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600 text-left">
                <th className="py-2.5 px-3">Código</th>
                <th className="py-2.5 px-3">Descripción / Familia</th>
                <th className="py-2.5 px-3">Ubicación</th>
                <th className="py-2.5 px-3 text-right">ERP Físico</th>
                <th className="py-2.5 px-3 text-right">Comprometido</th>
                <th className="py-2.5 px-3 text-right">Revisión / Rotura</th>
                <th className="py-2.5 px-3 text-right">POS Local</th>
                <th className="py-2.5 px-3 text-right">Disponible</th>
                <th className="py-2.5 px-3 text-right">Costo / PVP</th>
                <th className="py-2.5 px-3">Act. ERP</th>
                {currentUser.role === UserRole.JEFE_STOCK && <th className="py-2.5 px-3">Acción</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.balance_id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="py-2.5 px-3 font-mono font-semibold text-slate-900">
                    {row.sku}
                    {row.alias && (
                      <div className="text-[11px] font-normal text-slate-500">Alias: {row.alias}</div>
                    )}
                  </td>
                  <td className="py-2.5 px-3">
                    <div className="font-medium text-slate-900">{row.description}</div>
                    <div className="text-[11px] text-slate-500">
                      {row.family} · {row.brand} · {row.unit_of_measure}
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-slate-700">{row.location_name}</td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                    {row.erp_physical_stock}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums text-amber-700">
                    {row.committed_stock}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600">
                    {row.review_stock} / {row.damaged_stock}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600">
                    {row.pos_pending_sync}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono font-bold tabular-nums text-emerald-700">
                    {row.available_stock}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600">
                    {row.cost_price !== null ? `$${row.cost_price}` : '—'} /{' '}
                    {row.sale_price !== null ? `$${row.sale_price}` : '—'}
                  </td>
                  <td className="py-2.5 px-3 font-mono text-[11px] text-slate-500">
                    {row.last_erp_updated_at ? row.last_erp_updated_at.slice(0, 16).replace('T', ' ') : '—'}
                  </td>
                  {currentUser.role === UserRole.JEFE_STOCK && (
                    <td className="py-2.5 px-3">
                      <button
                        onClick={() => {
                          setBucketTarget(row);
                          setBucketForm({
                            reviewStock: row.review_stock,
                            damagedStock: row.damaged_stock,
                            reason: '',
                          });
                        }}
                        className="text-blue-700 hover:underline font-medium whitespace-nowrap"
                      >
                        Revisión/Rotura
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : viewMode === 'consolidated' ? (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600 text-left">
                <th className="py-2.5 px-3">Código</th>
                <th className="py-2.5 px-3">Descripción</th>
                <th className="py-2.5 px-3">Familia / Marca</th>
                <th className="py-2.5 px-3 text-right">Ubic.</th>
                <th className="py-2.5 px-3 text-right">Total ERP Físico</th>
                <th className="py-2.5 px-3 text-right">Comprometido</th>
                <th className="py-2.5 px-3 text-right">Rev. / Rotura</th>
                <th className="py-2.5 px-3 text-right">Total Disponible</th>
              </tr>
            </thead>
            <tbody>
              {consolidated.map((c) => (
                <tr key={c.product_id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="py-2.5 px-3 font-mono font-semibold text-slate-900">{c.sku}</td>
                  <td className="py-2.5 px-3 font-medium text-slate-900">{c.description}</td>
                  <td className="py-2.5 px-3 text-slate-600">
                    {c.family} · {c.brand}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                    {c.locations_count > 0 ? `${c.locations_count} dep.` : 'Maestro Global'}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums">{c.total_erp_physical}</td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums text-amber-700">
                    {c.total_committed}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                    {c.total_review} / {c.total_damaged}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono font-bold tabular-nums text-emerald-700">
                    {c.total_available}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600 text-left">
                <th className="py-2.5 px-3">ID</th>
                <th className="py-2.5 px-3">Nombre del Archivo</th>
                <th className="py-2.5 px-3">Fecha de Subida</th>
                <th className="py-2.5 px-3">Subido por</th>
                <th className="py-2.5 px-3 text-right">Filas</th>
                <th className="py-2.5 px-3 text-right">Nuevos / Act.</th>
                <th className="py-2.5 px-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loadingBatches ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-500">
                    Cargando historial de importaciones...
                  </td>
                </tr>
              ) : batches.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-500">
                    Aún no se registran importaciones de Excel.
                  </td>
                </tr>
              ) : (
                batches.map((b) => (
                  <tr key={b.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="py-2.5 px-3 font-mono font-semibold text-slate-900">#{b.id}</td>
                    <td className="py-2.5 px-3 font-medium text-slate-900">
                      {b.filename}
                      <div className="text-[11px] font-mono text-slate-500">
                        Corte ERP: {b.cutoff_timestamp ? b.cutoff_timestamp.slice(0, 16).replace('T', ' ') : '—'}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-slate-700">
                      {b.created_at ? b.created_at.slice(0, 19).replace('T', ' ') : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-slate-700">{b.uploaded_by_name}</td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums">{Number(b.total_rows)}</td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600">
                      +{Number(b.inserted_products)} / {Number(b.updated_balances)}
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <button
                        type="button"
                        disabled={deletingBatchId === b.id}
                        onClick={() => setBatchToDelete(b)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        {deletingBatchId === b.id ? 'Eliminando...' : 'Eliminar'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Excel Import Wizard Modal */}
      {showImportModal && (
        <div className="fixed inset-0 bg-slate-900/60 flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Importación de Excel del ERP — Paso {importStep} de 3
                </h3>
                <p className="text-xs text-slate-500">
                  Detección automática de columnas, validación previa de integridad y registro de corte histórico.
                </p>
              </div>
              <button onClick={() => setShowImportModal(false)} className="p-1 text-slate-500 hover:text-slate-900">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-5 flex-1">
              {importStep === 1 && (
                <div className="space-y-4">
                  <div className="border-2 border-dashed border-slate-300 rounded-xl p-8 text-center">
                    <Upload className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                    <p className="text-sm font-medium text-slate-900 mb-1">
                      Seleccione el archivo Excel (.xlsx o .xls) exportado desde su ERP
                    </p>
                    <p className="text-xs text-slate-500 mb-4">
                      Las columnas no reconocidas se conservarán automáticamente como atributos extendidos del artículo.
                    </p>
                    <input
                      type="file"
                      accept=".xlsx,.xls"
                      onChange={handleFileUpload}
                      disabled={importing}
                      className="text-xs text-slate-700 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-slate-900 file:text-white hover:file:bg-slate-800"
                    />
                  </div>
                </div>
              )}

              {importStep === 2 && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-4 bg-slate-50 p-3 rounded-lg border border-slate-200">
                    <div className="text-xs">
                      <span className="font-semibold text-slate-900">{importFileName}</span> ·{' '}
                      <span className="font-mono">{excelRows.length}</span> filas detectadas
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs font-medium text-slate-700">Fecha/Hora Corte ERP:</label>
                      <input
                        type="datetime-local"
                        value={cutoffTimestamp}
                        onChange={(e) => setCutoffTimestamp(e.target.value)}
                        className="px-2 py-1 text-xs border border-slate-300 rounded bg-white font-mono"
                      />
                    </div>
                  </div>

                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700">
                    <strong>Almacén Maestro Global:</strong> la columna <em>Depósito / Ubicación</em> es{' '}
                    <strong>opcional</strong>. Si el archivo contiene el catálogo general para todos los depósitos (o filas sin depósito), deje esa columna sin mapear o vacía y se validarán e incorporarán al Almacén Maestro para asignar luego depósito y familia a los responsables de conteo.
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {mapFieldLabels.map((f) => (
                      <div key={f.key} className="flex items-center justify-between gap-2 p-2.5 border border-slate-200 rounded-lg">
                        <label className="text-xs font-medium text-slate-700">
                          {f.label} {f.required && <span className="text-red-600">*</span>}
                        </label>
                        <select
                          value={mapping[f.key] || ''}
                          onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value })}
                          className="w-52 px-2 py-1.5 text-xs border border-slate-300 rounded bg-white"
                        >
                          <option value="">-- No mapear --</option>
                          {excelHeaders.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {importStep === 3 && validation && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
                    <div className="p-3 border border-slate-200 rounded-lg">
                      <div className="text-slate-500">Filas Totales</div>
                      <div className="text-lg font-mono font-bold text-slate-900">{validation.totalRows}</div>
                    </div>
                    <div className="p-3 border border-slate-200 rounded-lg">
                      <div className="text-slate-500">Filas Válidas</div>
                      <div className="text-lg font-mono font-bold text-emerald-700">
                        {validation.validRowsCount}
                      </div>
                    </div>
                    <div className="p-3 border border-slate-200 rounded-lg">
                      <div className="text-slate-500">Artículos Nuevos</div>
                      <div className="text-lg font-mono font-bold text-blue-700">
                        {validation.newProductsCount}
                      </div>
                    </div>
                    <div className="p-3 border border-slate-200 rounded-lg">
                      <div className="text-slate-500">Catálogo Global</div>
                      <div className="text-lg font-mono font-bold text-slate-900">
                        {validation.globalMasterRowsCount}
                      </div>
                    </div>
                    <div className="p-3 border border-slate-200 rounded-lg">
                      <div className="text-slate-500">Duplicados / Error Ubic.</div>
                      <div className="text-lg font-mono font-bold text-red-700">
                        {validation.duplicateSkuLocationPairs} / {validation.unmappedLocations.length}
                      </div>
                    </div>
                  </div>

                  {validation.issues.length > 0 && (
                    <div className="border border-amber-200 bg-amber-50 rounded-lg p-3 space-y-1.5 max-h-48 overflow-y-auto">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-900">
                        <AlertTriangle className="w-4 h-4" />
                        Observaciones de Validación ({validation.issues.length})
                      </div>
                      {validation.issues.map((iss, idx) => (
                        <div
                          key={idx}
                          className={`text-xs ${
                            iss.severity === 'ERROR' ? 'text-red-700' : 'text-amber-800'
                          }`}
                        >
                          Fila {iss.rowNumber} ({iss.sku}) [{iss.severity}]: {iss.message}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="border border-slate-200 rounded-lg overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
                          <th className="py-2 px-3">Fila</th>
                          <th className="py-2 px-3">Código</th>
                          <th className="py-2 px-3">Descripción</th>
                          <th className="py-2 px-3">Familia</th>
                          <th className="py-2 px-3">Alcance / Ubicación</th>
                          <th className="py-2 px-3 text-right">ERP</th>
                          <th className="py-2 px-3 text-right">Disp.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {validation.sampleRows.map((sr) => (
                          <tr key={sr.rowNumber} className="border-b border-slate-100">
                            <td className="py-1.5 px-3 font-mono">{sr.rowNumber}</td>
                            <td className="py-1.5 px-3 font-mono font-medium">
                              {sr.sku} {sr.isNewProduct ? '(Nuevo)' : ''}
                            </td>
                            <td className="py-1.5 px-3">{sr.description}</td>
                            <td className="py-1.5 px-3 text-slate-600">{sr.family}</td>
                            <td className="py-1.5 px-3">
                              {sr.matchedLocationId ? (
                                sr.locationName
                              ) : sr.isGlobalMaster ? (
                                <span className="text-slate-700 font-medium">{sr.locationName}</span>
                              ) : (
                                <span className="text-red-700">⚠ {sr.locationName}</span>
                              )}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono tabular-nums">{sr.erpStock}</td>
                            <td className="py-1.5 px-3 text-right font-mono font-semibold tabular-nums">
                              {sr.availableCalculated}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between">
              <div>
                {importStep > 1 && (
                  <button
                    onClick={() => setImportStep((importStep - 1) as 1 | 2)}
                    className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 bg-white rounded-lg"
                  >
                    Atrás
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowImportModal(false)}
                  className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 bg-white rounded-lg"
                >
                  Cancelar
                </button>
                {importStep === 2 && (
                  <button
                    onClick={handleValidateMapping}
                    disabled={importing || !mapping.sku || !mapping.description}
                    className="px-4 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50"
                  >
                    {importing ? 'Validando...' : 'Validar Archivo'}
                  </button>
                )}
                {importStep === 3 && validation && (
                  <button
                    onClick={handleCommitImport}
                    disabled={importing || validation.validRowsCount === 0}
                    className="px-4 py-1.5 text-xs font-medium text-white bg-[#8e0d0d] rounded-lg hover:bg-[#6e0909] disabled:opacity-50"
                  >
                    {importing
                      ? 'Importando...'
                      : `Confirmar Importación (${validation.validRowsCount} filas válidas)`}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Stock Review / Damaged Bucket Modal */}
      {bucketTarget && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6">
            <h3 className="text-base font-bold text-slate-900 mb-1">Clasificación Especial de Stock</h3>
            <p className="text-xs text-slate-500 mb-4">
              {bucketTarget.sku} · {bucketTarget.description} ({bucketTarget.location_name})
            </p>
            <form onSubmit={handleSaveBuckets} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Stock en Revisión
                </label>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={bucketForm.reviewStock}
                  onChange={(e) => setBucketForm({ ...bucketForm, reviewStock: Number(e.target.value) })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Stock en Rotura / Avería
                </label>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={bucketForm.damagedStock}
                  onChange={(e) => setBucketForm({ ...bucketForm, damagedStock: Number(e.target.value) })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Motivo / Auditoría</label>
                <input
                  type="text"
                  required
                  value={bucketForm.reason}
                  onChange={(e) => setBucketForm({ ...bucketForm, reason: e.target.value })}
                  placeholder="Ej. Material dañado separado en depósito"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setBucketTarget(null)}
                  className="px-4 py-2 text-xs border border-slate-300 rounded-lg"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg"
                >
                  Guardar Clasificación
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirm Delete Import Batch Modal */}
      {batchToDelete && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-red-50 text-red-600 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Eliminar Lote de Importación #{batchToDelete.id}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5 break-all">{batchToDelete.filename}</p>
              </div>
            </div>
            <p className="text-xs text-slate-700 leading-relaxed bg-amber-50 border border-amber-200 rounded-lg p-3">
              ¿Seguro que deseas eliminar este registro de importación? Esta acción no se puede
              deshacer. Los productos ya importados NO se borrarán.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={deletingBatchId !== null}
                onClick={() => setBatchToDelete(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={deletingBatchId !== null}
                onClick={handleConfirmDeleteBatch}
                className="px-4 py-2 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50"
              >
                {deletingBatchId !== null ? 'Eliminando...' : 'Confirmar Eliminación'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
