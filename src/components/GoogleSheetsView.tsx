import React, { useEffect, useMemo, useState } from 'react';
import { User } from 'firebase/auth';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileSpreadsheet,
  FolderSearch,
  LogOut,
  Plus,
  RefreshCw,
  Table2,
  Upload,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import {
  getGoogleAccessToken,
  googleSignIn,
  googleSignOut,
  initGoogleAuth,
} from '../lib/googleAuth';
import {
  createGoogleSpreadsheet,
  DriveSpreadsheetFile,
  extractSpreadsheetId,
  getSpreadsheetMetadata,
  listDriveSpreadsheets,
  overwriteSheetValues,
  readSheetValues,
  SpreadsheetMetadata,
} from '../lib/googleSheetsApi';
import { AuthUser, ExcelColumnMapping, UserRole } from '../types/erp';

type SyncDataset = 'consolidated' | 'by_location' | 'counts';

interface ConfirmWriteState {
  mode: 'create' | 'overwrite';
  title: string;
  sheetTitle: string;
  spreadsheetId?: string;
  rowsCount: number;
  values: (string | number)[][];
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
}

const HEADER_SYNONYMS: Record<keyof ExcelColumnMapping, string[]> = {
  sku: ['codigo', 'cod', 'sku', 'codigo de articulo', 'articulo', 'code'],
  description: ['descripcion', 'nombre', 'detalle', 'producto', 'description'],
  alias: ['alias', 'cod_barra', 'barra', 'referencia'],
  family: ['familia', 'rubro', 'categoria', 'linea', 'grupo'],
  brand: ['marca', 'fabricante', 'brand'],
  unitOfMeasure: ['unidad', 'um', 'u.m.', 'unidad de medida', 'medida'],
  erpStock: ['existencia', 'stock', 'stock_fisico', 'existencia_erp', 'cantidad', 'saldo'],
  location: ['deposito', 'ubicacion', 'sucursal', 'almacen', 'bodega'],
  costPrice: ['costo', 'precio_costo', 'costo_unitario', 'cost'],
  salePrice: ['precio', 'precio_venta', 'precio de venta', 'pvp', 'venta'],
  committedStock: ['comprometido', 'stock comprometido', 'reservado'],
  criticality: ['criticidad', 'prioridad'],
};

function normalizeHeaderName(val: string): string {
  return val
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

function suggestMappingFromHeaders(headers: string[]): ExcelColumnMapping {
  const suggested: Partial<ExcelColumnMapping> = {};
  (Object.keys(HEADER_SYNONYMS) as Array<keyof ExcelColumnMapping>).forEach((field) => {
    const syns = HEADER_SYNONYMS[field].map(normalizeHeaderName);
    const match = headers.find((h) => {
      const norm = normalizeHeaderName(h);
      return syns.includes(norm) || syns.some((s) => norm.includes(s));
    });
    if (match) suggested[field] = match;
  });
  return {
    sku: suggested.sku || '',
    description: suggested.description || '',
    alias: suggested.alias || '',
    family: suggested.family || '',
    brand: suggested.brand || '',
    unitOfMeasure: suggested.unitOfMeasure || '',
    erpStock: suggested.erpStock || '',
    location: suggested.location || '',
    costPrice: suggested.costPrice || '',
    salePrice: suggested.salePrice || '',
    committedStock: suggested.committedStock || '',
    criticality: suggested.criticality || '',
  };
}

export const GoogleSheetsView: React.FC<{ currentUser: AuthUser }> = ({ currentUser }) => {
  const [needsAuth, setNeedsAuth] = useState(true);
  const [googleUser, setGoogleUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(() => getGoogleAccessToken());
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const [driveSearch, setDriveSearch] = useState('');
  const [driveFiles, setDriveFiles] = useState<DriveSpreadsheetFile[]>([]);
  const [loadingDrive, setLoadingDrive] = useState(false);
  const [manualSpreadsheetInput, setManualSpreadsheetInput] = useState('');

  const [metadata, setMetadata] = useState<SpreadsheetMetadata | null>(null);
  const [selectedSheetTitle, setSelectedSheetTitle] = useState('');
  const [loadingSheet, setLoadingSheet] = useState(false);
  const [sheetHeaders, setSheetHeaders] = useState<string[]>([]);
  const [sheetRows, setSheetRows] = useState<Record<string, unknown>[]>([]);

  const [activeActionTab, setActiveActionTab] = useState<'import' | 'export'>(
    currentUser.role === UserRole.JEFE_STOCK ? 'import' : 'export'
  );

  // Import into Almacen Maestro state
  const [mapping, setMapping] = useState<ExcelColumnMapping>({ sku: '', description: '' });
  const [validation, setValidation] = useState<ValidationPreview | null>(null);
  const [validatingImport, setValidatingImport] = useState(false);
  const [committingImport, setCommittingImport] = useState(false);

  // Export / Sync to Google Sheets state
  const [syncDataset, setSyncDataset] = useState<SyncDataset>('consolidated');
  const [newSheetTitle, setNewSheetTitle] = useState(
    `MercoMat_Almacen_Maestro_${new Date().toISOString().slice(0, 10)}`
  );
  const [newTabTitle, setNewTabTitle] = useState('Almacen_Maestro');
  const [confirmWrite, setConfirmWrite] = useState<ConfirmWriteState | null>(null);
  const [writingSheet, setWritingSheet] = useState(false);
  const [lastCreatedUrl, setLastCreatedUrl] = useState<string | null>(null);

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDriveFiles = async (query = driveSearch) => {
    setLoadingDrive(true);
    setError(null);
    try {
      const files = await listDriveSpreadsheets(query);
      setDriveFiles(files);
    } catch (err: unknown) {
      const msg = (err as Error).message;
      setError(msg);
      if (!getGoogleAccessToken()) {
        setAccessToken(null);
        setNeedsAuth(true);
      }
    } finally {
      setLoadingDrive(false);
    }
  };

  useEffect(() => {
    const existing = getGoogleAccessToken();
    if (existing) {
      setAccessToken(existing);
      setNeedsAuth(false);
      loadDriveFiles('');
    }
    const unsub = initGoogleAuth(
      (user, token) => {
        setGoogleUser(user);
        setAccessToken(token);
        setNeedsAuth(false);
      },
      () => {
        setGoogleUser(null);
        setAccessToken(null);
        setNeedsAuth(true);
      }
    );
    return () => unsub();
  }, []);

  const handleGoogleLogin = async () => {
    setIsLoggingIn(true);
    setError(null);
    try {
      const res = await googleSignIn();
      setGoogleUser(res.user);
      setAccessToken(res.accessToken);
      setNeedsAuth(false);
      await loadDriveFiles('');
    } catch (err: unknown) {
      setError((err as Error).message || 'No se pudo completar la autenticación con Google.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleGoogleLogout = async () => {
    await googleSignOut();
    setGoogleUser(null);
    setAccessToken(null);
    setNeedsAuth(true);
    setDriveFiles([]);
    setMetadata(null);
    setSheetHeaders([]);
    setSheetRows([]);
    setValidation(null);
  };

  const handleSelectSpreadsheet = async (idOrUrl: string) => {
    const cleanId = extractSpreadsheetId(idOrUrl);
    if (!cleanId) return;
    setLoadingSheet(true);
    setError(null);
    setStatusMessage(null);
    setValidation(null);
    try {
      const meta = await getSpreadsheetMetadata(cleanId);
      setMetadata(meta);
      const firstSheet = meta.sheets[0]?.title || '';
      setSelectedSheetTitle(firstSheet);
      if (firstSheet) {
        const values = await readSheetValues(meta.spreadsheetId, firstSheet);
        setSheetHeaders(values.headers);
        setSheetRows(values.rows);
        setMapping(suggestMappingFromHeaders(values.headers));
      } else {
        setSheetHeaders([]);
        setSheetRows([]);
      }
    } catch (err: unknown) {
      setError((err as Error).message);
      if (!getGoogleAccessToken()) {
        setAccessToken(null);
        setNeedsAuth(true);
      }
    } finally {
      setLoadingSheet(false);
    }
  };

  const handleChangeSheetTab = async (tabTitle: string) => {
    if (!metadata) return;
    setSelectedSheetTitle(tabTitle);
    setLoadingSheet(true);
    setError(null);
    setValidation(null);
    try {
      const values = await readSheetValues(metadata.spreadsheetId, tabTitle);
      setSheetHeaders(values.headers);
      setSheetRows(values.rows);
      setMapping(suggestMappingFromHeaders(values.headers));
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoadingSheet(false);
    }
  };

  const handleValidateImport = async () => {
    if (sheetRows.length === 0 || !mapping.sku || !mapping.description) {
      setError('Seleccione una hoja con filas y mapee al menos Código de artículo y Descripción.');
      return;
    }
    setValidatingImport(true);
    setError(null);
    setStatusMessage(null);
    try {
      const res = await apiFetch<{ preview: ValidationPreview }>('/api/inventory/import/validate', {
        method: 'POST',
        body: JSON.stringify({ rows: sheetRows, mapping }),
      });
      setValidation(res.preview);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setValidatingImport(false);
    }
  };

  const handleCommitImport = async () => {
    if (!metadata || !validation || validation.validRowsCount === 0) return;
    setCommittingImport(true);
    setError(null);
    try {
      const res = await apiFetch<{
        batchId: number;
        insertedProducts: number;
        updatedProducts: number;
        updatedBalances: number;
        skippedErrors: number;
      }>('/api/inventory/import/commit', {
        method: 'POST',
        body: JSON.stringify({
          filename: `GoogleSheet: ${metadata.title} [${selectedSheetTitle}]`,
          cutoffTimestamp: new Date().toISOString(),
          rows: sheetRows,
          mapping,
        }),
      });
      setStatusMessage(
        `Sincronización completada (Lote #${res.batchId}): ${res.insertedProducts} artículo(s) nuevo(s), ${res.updatedProducts} actualizado(s), ${res.updatedBalances} saldo(s) por depósito.`
      );
      setValidation(null);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setCommittingImport(false);
    }
  };

  const buildDatasetValues = async (dataset: SyncDataset): Promise<(string | number)[][]> => {
    if (dataset === 'counts') {
      const res = await apiFetch<{ counts: Array<Record<string, unknown>> }>('/api/counts');
      const header = [
        'Nro. Conteo',
        'Ubicación',
        'Fecha Programada',
        'Estado',
        'Responsable Conteo',
        'Ítems',
        'Contados',
        'Diferencias',
      ];
      const rows = res.counts.map((c) => [
        String(c.count_number || ''),
        String(c.location_name || ''),
        String(c.scheduled_date || ''),
        String(c.status || ''),
        String(c.counter_name || ''),
        Number(c.items_count || 0),
        Number(c.counted_items_count || 0),
        c.discrepancies_count !== null && c.discrepancies_count !== undefined
          ? Number(c.discrepancies_count)
          : '',
      ]);
      return [header, ...rows];
    }

    const inv = await apiFetch<{
      items: Array<Record<string, unknown>>;
      consolidated: Array<Record<string, unknown>>;
    }>('/api/inventory');

    if (dataset === 'by_location') {
      const header = [
        'Código de artículo',
        'Descripción',
        'Familia',
        'Marca',
        'Unidad de medida',
        'Depósito',
        'Existencia',
        'Stock comprometido',
        'En Revisión',
        'Rotura',
        'Disponible',
        'Costo',
        'Precio de venta',
      ];
      const rows = inv.items.map((it) => [
        String(it.sku || ''),
        String(it.description || ''),
        String(it.family || ''),
        String(it.brand || ''),
        String(it.unit_of_measure || 'UN'),
        String(it.location_name || ''),
        Number(it.erp_physical_stock || 0),
        Number(it.committed_stock || 0),
        Number(it.review_stock || 0),
        Number(it.damaged_stock || 0),
        Number(it.available_stock || 0),
        it.cost_price !== null && it.cost_price !== undefined ? Number(it.cost_price) : '',
        it.sale_price !== null && it.sale_price !== undefined ? Number(it.sale_price) : '',
      ]);
      return [header, ...rows];
    }

    const header = [
      'Código de artículo',
      'Descripción',
      'Alias',
      'Familia',
      'Marca',
      'Unidad de medida',
      'Depósitos con Saldo',
      'Existencia Total ERP',
      'Stock Comprometido',
      'Disponible Total',
      'Costo',
      'Precio de venta',
    ];
    const rows = inv.consolidated.map((c) => [
      String(c.sku || ''),
      String(c.description || ''),
      String(c.alias || ''),
      String(c.family || ''),
      String(c.brand || ''),
      String(c.unit_of_measure || 'UN'),
      Number(c.locations_count || 0),
      Number(c.total_erp_physical || 0),
      Number(c.total_committed || 0),
      Number(c.total_available || 0),
      c.cost_price !== null && c.cost_price !== undefined ? Number(c.cost_price) : '',
      c.sale_price !== null && c.sale_price !== undefined ? Number(c.sale_price) : '',
    ]);
    return [header, ...rows];
  };

  const handlePrepareWrite = async (mode: 'create' | 'overwrite') => {
    setError(null);
    setStatusMessage(null);
    if (mode === 'overwrite' && (!metadata || !selectedSheetTitle)) {
      setError('Seleccione primero una planilla de Google Sheets y una pestaña destino.');
      return;
    }
    if (mode === 'create' && (!newSheetTitle.trim() || !newTabTitle.trim())) {
      setError('Ingrese el nombre de la nueva planilla y de la pestaña.');
      return;
    }

    try {
      const values = await buildDatasetValues(syncDataset);
      if (values.length <= 1) {
        setError('No hay registros en el sistema para exportar en la vista seleccionada.');
        return;
      }

      setConfirmWrite({
        mode,
        title: mode === 'create' ? newSheetTitle.trim() : metadata!.title,
        sheetTitle: mode === 'create' ? newTabTitle.trim() : selectedSheetTitle,
        spreadsheetId: mode === 'overwrite' ? metadata!.spreadsheetId : undefined,
        rowsCount: values.length - 1,
        values,
      });
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const handleExecuteConfirmedWrite = async () => {
    if (!confirmWrite) return;
    setWritingSheet(true);
    setError(null);
    try {
      if (confirmWrite.mode === 'create') {
        const created = await createGoogleSpreadsheet({
          title: confirmWrite.title,
          sheetTitle: confirmWrite.sheetTitle,
          values: confirmWrite.values,
        });
        setLastCreatedUrl(created.spreadsheetUrl);
        setStatusMessage(
          `Nueva hoja de Google Sheets "${confirmWrite.title}" creada con ${confirmWrite.rowsCount} registro(s).`
        );
        await loadDriveFiles(driveSearch);
        await handleSelectSpreadsheet(created.spreadsheetId);
      } else if (confirmWrite.spreadsheetId) {
        const res = await overwriteSheetValues({
          spreadsheetId: confirmWrite.spreadsheetId,
          sheetTitle: confirmWrite.sheetTitle,
          values: confirmWrite.values,
        });
        setStatusMessage(
          `Pestaña "${confirmWrite.sheetTitle}" de "${confirmWrite.title}" actualizada (${res.updatedRows} filas escritas).`
        );
        await handleChangeSheetTab(confirmWrite.sheetTitle);
      }
      setConfirmWrite(null);
    } catch (err: unknown) {
      setError((err as Error).message);
      if (!getGoogleAccessToken()) {
        setAccessToken(null);
        setNeedsAuth(true);
      }
    } finally {
      setWritingSheet(false);
    }
  };

  const mappingFields: Array<{ key: keyof ExcelColumnMapping; label: string; required?: boolean }> = [
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
    { key: 'alias', label: 'Alias' },
    { key: 'criticality', label: 'Criticidad' },
  ];

  const previewRows = useMemo(() => sheetRows.slice(0, 12), [sheetRows]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">
            Integración con Google Sheets y Google Drive
          </h2>
          <p className="text-sm text-slate-600 mt-0.5">
            Importe catálogos del Almacén Maestro directamente desde Google Sheets o sincronice inventarios y conteos hacia sus planillas en la nube.
          </p>
        </div>

        {!needsAuth && accessToken && (
          <div className="flex items-center gap-3 bg-white border border-slate-200 rounded-lg px-3.5 py-2 text-xs">
            <div className="min-w-0">
              <div className="font-semibold text-slate-900 truncate">
                {googleUser?.displayName || 'Cuenta Google conectada'}
              </div>
              <div className="text-[11px] text-slate-500 truncate">
                {googleUser?.email || 'Sesión activa'}
              </div>
            </div>
            <button
              type="button"
              onClick={handleGoogleLogout}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border border-slate-300 text-slate-700 rounded-md hover:bg-slate-50 whitespace-nowrap"
            >
              <LogOut className="w-3.5 h-3.5" />
              Desconectar
            </button>
          </div>
        )}
      </div>

      {statusMessage && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800 flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {statusMessage}
          </span>
          {lastCreatedUrl && (
            <a
              href={lastCreatedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-semibold underline"
            >
              Abrir en Google Sheets
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
          {error}
        </div>
      )}

      {needsAuth || !accessToken ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 max-w-2xl mx-auto text-center space-y-5">
          <div className="w-12 h-12 rounded-xl bg-red-50 border border-red-100 flex items-center justify-center mx-auto">
            <FileSpreadsheet className="w-6 h-6 text-[#8e0d0d]" />
          </div>
          <div className="space-y-1.5">
            <h3 className="text-lg font-bold text-slate-900">
              Conecte su cuenta de Google para acceder a Google Sheets
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed max-w-lg mx-auto">
              Con su autorización podrá listar planillas de cálculo desde Google Drive, leer pestañas para importar artículos al Almacén Maestro y exportar existencias o reportes de conteo.
            </p>
          </div>

          <div className="flex justify-center pt-1">
            <button
              type="button"
              onClick={handleGoogleLogin}
              disabled={isLoggingIn}
              className="gsi-material-button"
            >
              <div className="gsi-material-button-state" />
              <div className="gsi-material-button-content-wrapper">
                <div className="gsi-material-button-icon">
                  <svg
                    version="1.1"
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 48 48"
                    style={{ display: 'block' }}
                  >
                    <path
                      fill="#EA4335"
                      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                    />
                    <path
                      fill="#4285F4"
                      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                    />
                    <path
                      fill="#34A853"
                      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                    />
                    <path fill="none" d="M0 0h48v48H0z" />
                  </svg>
                </div>
                <span className="gsi-material-button-contents">
                  {isLoggingIn ? 'Conectando...' : 'Sign in with Google'}
                </span>
              </div>
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Panel: Drive Spreadsheets Explorer */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
                <FolderSearch className="w-4 h-4 text-[#8e0d0d]" />
                <span>Planillas en Google Drive</span>
              </div>
              <button
                type="button"
                onClick={() => loadDriveFiles(driveSearch)}
                disabled={loadingDrive}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap"
              >
                <RefreshCw className={`w-3 h-3 ${loadingDrive ? 'animate-spin' : ''}`} />
                Actualizar
              </button>
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                value={driveSearch}
                onChange={(e) => setDriveSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadDriveFiles(driveSearch)}
                placeholder="Buscar planilla en Drive..."
                className="flex-1 px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
              />
              <button
                type="button"
                onClick={() => loadDriveFiles(driveSearch)}
                className="px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-lg"
              >
                Buscar
              </button>
            </div>

            <div className="pt-2 border-t border-slate-100 space-y-1.5">
              <label className="block text-[11px] font-medium text-slate-600">
                O pegue URL / ID de Google Sheets
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={manualSpreadsheetInput}
                  onChange={(e) => setManualSpreadsheetInput(e.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  className="flex-1 px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg font-mono"
                />
                <button
                  type="button"
                  onClick={() => handleSelectSpreadsheet(manualSpreadsheetInput)}
                  disabled={!manualSpreadsheetInput.trim() || loadingSheet}
                  className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                >
                  Abrir
                </button>
              </div>
            </div>

            <div className="border border-slate-200 rounded-lg max-h-80 overflow-y-auto divide-y divide-slate-100">
              {loadingDrive ? (
                <div className="p-6 text-center text-xs text-slate-500">
                  Consultando Google Drive...
                </div>
              ) : driveFiles.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-500">
                  No se encontraron hojas de cálculo en Google Drive. Puede crear una nueva desde el panel derecho.
                </div>
              ) : (
                driveFiles.map((file) => {
                  const selected = metadata?.spreadsheetId === file.id;
                  return (
                    <button
                      type="button"
                      key={file.id}
                      onClick={() => handleSelectSpreadsheet(file.id)}
                      className={`w-full text-left px-3 py-2.5 text-xs transition-colors ${
                        selected ? 'bg-red-50/70 text-[#8e0d0d]' : 'hover:bg-slate-50 text-slate-800'
                      }`}
                    >
                      <div className="font-semibold truncate">{file.name}</div>
                      <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                        {file.modifiedTime ? `Modif: ${file.modifiedTime.slice(0, 10)}` : file.id}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Right Panel: Selected Sheet + Import / Export Actions */}
          <div className="lg:col-span-2 space-y-5">
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                  {currentUser.role === UserRole.JEFE_STOCK && (
                    <button
                      type="button"
                      onClick={() => setActiveActionTab('import')}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                        activeActionTab === 'import'
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600'
                      }`}
                    >
                      Importar desde Google Sheets
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setActiveActionTab('export')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                      activeActionTab === 'export'
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600'
                    }`}
                  >
                    Exportar / Sincronizar hacia Sheets
                  </button>
                </div>

                {metadata && (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-semibold text-slate-900 truncate max-w-[200px]">
                      {metadata.title}
                    </span>
                    <select
                      value={selectedSheetTitle}
                      onChange={(e) => handleChangeSheetTab(e.target.value)}
                      className="px-2.5 py-1 border border-slate-300 rounded-md bg-white text-xs"
                    >
                      {metadata.sheets.map((s) => (
                        <option key={s.sheetId} value={s.title}>
                          {s.title}
                        </option>
                      ))}
                    </select>
                    {metadata.spreadsheetUrl && (
                      <a
                        href={metadata.spreadsheetUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 border border-slate-300 rounded-md text-slate-700 hover:bg-slate-50"
                        title="Abrir en Google Sheets"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                )}
              </div>

              {activeActionTab === 'import' && currentUser.role === UserRole.JEFE_STOCK ? (
                !metadata ? (
                  <div className="py-12 text-center text-xs text-slate-500 border border-dashed border-slate-300 rounded-lg">
                    Seleccione una planilla de Google Sheets en el panel izquierdo para leer sus pestañas e importar artículos al Almacén Maestro.
                  </div>
                ) : loadingSheet ? (
                  <div className="py-10 text-center text-xs text-slate-500">
                    Leyendo datos de Google Sheets...
                  </div>
                ) : sheetRows.length === 0 ? (
                  <div className="py-10 text-center text-xs text-slate-500">
                    La pestaña "{selectedSheetTitle}" no contiene filas de datos.
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 flex flex-wrap items-center justify-between gap-2">
                      <span>
                        Pestaña <strong>{selectedSheetTitle}</strong>: <strong className="font-mono">{sheetRows.length}</strong> filas y <strong className="font-mono">{sheetHeaders.length}</strong> columnas leídas. La columna <em>Depósito</em> es opcional.
                      </span>
                      <button
                        type="button"
                        onClick={handleValidateImport}
                        disabled={validatingImport || !mapping.sku || !mapping.description}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-slate-900 text-white rounded-lg font-medium hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                      >
                        <Table2 className="w-3.5 h-3.5" />
                        {validatingImport ? 'Validando...' : 'Validar para Almacén Maestro'}
                      </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                      {mappingFields.map((f) => (
                        <div
                          key={f.key}
                          className="flex items-center justify-between gap-2 p-2 border border-slate-200 rounded-lg"
                        >
                          <label className="font-medium text-slate-700">
                            {f.label} {f.required && <span className="text-red-600">*</span>}
                          </label>
                          <select
                            value={mapping[f.key] || ''}
                            onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value })}
                            className="w-44 px-2 py-1 border border-slate-300 rounded bg-white text-xs"
                          >
                            <option value="">-- No mapear --</option>
                            {sheetHeaders.map((h) => (
                              <option key={h} value={h}>
                                {h}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>

                    {validation && (
                      <div className="border border-slate-200 rounded-lg p-4 space-y-3 bg-slate-50">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                          <div className="bg-white p-2.5 border border-slate-200 rounded-lg">
                            <div className="text-slate-500">Filas Válidas</div>
                            <div className="text-base font-mono font-bold text-emerald-700">
                              {validation.validRowsCount} / {validation.totalRows}
                            </div>
                          </div>
                          <div className="bg-white p-2.5 border border-slate-200 rounded-lg">
                            <div className="text-slate-500">Artículos Nuevos</div>
                            <div className="text-base font-mono font-bold text-blue-700">
                              {validation.newProductsCount}
                            </div>
                          </div>
                          <div className="bg-white p-2.5 border border-slate-200 rounded-lg">
                            <div className="text-slate-500">Catálogo Global</div>
                            <div className="text-base font-mono font-bold text-slate-900">
                              {validation.globalMasterRowsCount}
                            </div>
                          </div>
                          <div className="bg-white p-2.5 border border-slate-200 rounded-lg">
                            <div className="text-slate-500">Duplicados</div>
                            <div className="text-base font-mono font-bold text-red-700">
                              {validation.duplicateSkuLocationPairs}
                            </div>
                          </div>
                        </div>

                        {validation.issues.length > 0 && (
                          <div className="max-h-32 overflow-y-auto bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-xs space-y-1">
                            {validation.issues.map((iss, idx) => (
                              <div
                                key={idx}
                                className={
                                  iss.severity === 'ERROR' ? 'text-red-700' : 'text-amber-800'
                                }
                              >
                                Fila {iss.rowNumber} ({iss.sku}): {iss.message}
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={handleCommitImport}
                            disabled={committingImport || validation.validRowsCount === 0}
                            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-[#8e0d0d] text-white rounded-lg hover:bg-[#6e0909] disabled:opacity-50 whitespace-nowrap"
                          >
                            <Upload className="w-3.5 h-3.5" />
                            {committingImport
                              ? 'Importando...'
                              : `Importar ${validation.validRowsCount} filas al Almacén Maestro`}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Raw Preview Table */}
                    <div className="border border-slate-200 rounded-lg overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
                            {sheetHeaders.slice(0, 7).map((h) => (
                              <th key={h} className="py-2 px-2.5 whitespace-nowrap">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {previewRows.map((row, idx) => (
                            <tr key={idx} className="border-b border-slate-100">
                              {sheetHeaders.slice(0, 7).map((h) => (
                                <td key={h} className="py-1.5 px-2.5 text-slate-700 truncate max-w-[180px]">
                                  {String(row[h] ?? '')}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )
              ) : (
                /* Export / Sync Tab */
                <div className="space-y-5 text-xs">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1.5">
                      Conjunto de Datos MercoMat a Sincronizar
                    </label>
                    <select
                      value={syncDataset}
                      onChange={(e) => setSyncDataset(e.target.value as SyncDataset)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white text-xs"
                    >
                      <option value="consolidated">
                        Almacén Maestro Consolidado (todos los artículos)
                      </option>
                      <option value="by_location">
                        Existencias Individualizadas por Depósito / Sucursal
                      </option>
                      <option value="counts">Historial de Conteos y Conciliación</option>
                    </select>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="border border-slate-200 rounded-xl p-4 space-y-3">
                      <div className="font-bold text-slate-900 flex items-center gap-1.5">
                        <Plus className="w-4 h-4 text-[#8e0d0d]" />
                        <span>Crear Nueva Planilla en Google Drive</span>
                      </div>
                      <div>
                        <label className="block text-slate-600 mb-1">Nombre del Archivo</label>
                        <input
                          type="text"
                          value={newSheetTitle}
                          onChange={(e) => setNewSheetTitle(e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg"
                        />
                      </div>
                      <div>
                        <label className="block text-slate-600 mb-1">Nombre de la Pestaña</label>
                        <input
                          type="text"
                          value={newTabTitle}
                          onChange={(e) => setNewTabTitle(e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => handlePrepareWrite('create')}
                        className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-[#8e0d0d] text-white rounded-lg font-medium hover:bg-[#6e0909]"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Crear Nueva Google Sheet
                      </button>
                    </div>

                    <div className="border border-slate-200 rounded-xl p-4 space-y-3">
                      <div className="font-bold text-slate-900 flex items-center gap-1.5">
                        <RefreshCw className="w-4 h-4 text-slate-700" />
                        <span>Actualizar Planilla Existente</span>
                      </div>
                      <p className="text-slate-600 leading-relaxed">
                        {metadata
                          ? `Destino actual: "${metadata.title}" — pestaña "${selectedSheetTitle}".`
                          : 'Seleccione primero una planilla en el panel izquierdo para habilitar la sobrescritura controlada de una pestaña.'}
                      </p>
                      <button
                        type="button"
                        disabled={!metadata || !selectedSheetTitle}
                        onClick={() => handlePrepareWrite('overwrite')}
                        className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-slate-900 text-white rounded-lg font-medium hover:bg-slate-800 disabled:opacity-50"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        Actualizar Pestaña Seleccionada
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Mandatory User Confirmation Modal before Mutating Google Sheets */}
      {confirmWrite && (
        <div className="fixed inset-0 bg-slate-900/60 flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h3 className="text-base font-bold text-slate-900">
                  {confirmWrite.mode === 'create'
                    ? '¿Crear nueva planilla en Google Sheets?'
                    : '¿Sobrescribir datos en Google Sheets?'}
                </h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  {confirmWrite.mode === 'create'
                    ? `Se creará la hoja de cálculo "${confirmWrite.title}" en su Google Drive (pestaña "${confirmWrite.sheetTitle}") con ${confirmWrite.rowsCount} registro(s).`
                    : `Se limpiará y reemplazará todo el contenido de la pestaña "${confirmWrite.sheetTitle}" en "${confirmWrite.title}" con ${confirmWrite.rowsCount} registro(s). Esta operación modificará su archivo en Google Sheets.`}
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirmWrite(null)}
                disabled={writingSheet}
                className="px-4 py-2 text-xs font-medium border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleExecuteConfirmedWrite}
                disabled={writingSheet}
                className="px-4 py-2 text-xs font-medium bg-[#8e0d0d] text-white rounded-lg hover:bg-[#6e0909] disabled:opacity-50"
              >
                {writingSheet ? 'Sincronizando...' : 'Confirmar Operación'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
