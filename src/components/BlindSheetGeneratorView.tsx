import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  CheckCircle2,
  CheckSquare,
  ClipboardList,
  Download,
  FileSpreadsheet,
  Printer,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Square,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { exportBlindCountSheetPdf, MERCOMAT_LOGO_URL } from '../lib/pdfExport';
import { AuthUser, LocationRecord, UserRole } from '../types/erp';

interface BlindCatalogItem {
  product_id: number;
  sku: string;
  description: string;
  alias: string;
  family: string;
  brand: string;
  rubro: string;
  unit_of_measure: string;
  location_id: number;
  location_name: string;
  location_group: string;
}

interface UserOption {
  id: number;
  fullName: string;
  username?: string;
  role: UserRole;
}

interface RegisteredCountInfo {
  countId: number;
  countNumber: string;
  documentUid: string;
  status: string;
}

interface BlindSheetGeneratorViewProps {
  currentUser: AuthUser;
  onNavigateToManagement?: () => void;
  onNavigateToWorkspace?: (countId: number) => void;
}

function getTodayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getCurrentTime(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function createSheetIdentifier(): { countNumber: string; documentUid: string } {
  const datePart = getTodayIso().replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  const uid = `BLD-${datePart}-${rand}`;
  return { countNumber: `PC-${datePart}-${rand}`, documentUid: uid };
}

export const BlindSheetGeneratorView: React.FC<BlindSheetGeneratorViewProps> = ({
  currentUser,
  onNavigateToManagement,
  onNavigateToWorkspace,
}) => {
  const [locations, setLocations] = useState<LocationRecord[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState<string>('');
  const [selectedFamily, setSelectedFamily] = useState<string>('');
  const [selectedRubro, setSelectedRubro] = useState<string>('');
  const [selectedSingleProductId, setSelectedSingleProductId] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState<string>('');

  const [catalogItems, setCatalogItems] = useState<BlindCatalogItem[]>([]);
  const [families, setFamilies] = useState<string[]>([]);
  const [rubros, setRubros] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);

  const [scheduledDate, setScheduledDate] = useState<string>(getTodayIso);
  const [scheduledTime, setScheduledTime] = useState<string>(getCurrentTime);
  const [counterName, setCounterName] = useState<string>(currentUser.fullName);
  const [selectedCounterId, setSelectedCounterId] = useState<string>(
    currentUser.role === UserRole.CONTADOR || currentUser.role === UserRole.JEFE_STOCK
      ? String(currentUser.id)
      : ''
  );
  const [warehouseManagerName, setWarehouseManagerName] = useState<string>('');
  const [sheetMeta, setSheetMeta] = useState(createSheetIdentifier);
  const [counterOptions, setCounterOptions] = useState<UserOption[]>([]);

  const [registerOnEmit, setRegisterOnEmit] = useState<boolean>(true);
  const [registeredCount, setRegisteredCount] = useState<RegisteredCountInfo | null>(null);
  const [registering, setRegistering] = useState<boolean>(false);

  const [loadingLocations, setLoadingLocations] = useState(true);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadInitial = async () => {
      setLoadingLocations(true);
      setError(null);
      try {
        const locRes = await apiFetch<{ locations: LocationRecord[] }>('/api/locations');
        setLocations(locRes.locations);
        if (locRes.locations.length > 0) {
          const first = locRes.locations[0];
          setSelectedLocationId(String(first.id));
          setWarehouseManagerName(first.managerName || '');
        }
      } catch (err: unknown) {
        setError((err as Error).message);
      } finally {
        setLoadingLocations(false);
      }
    };
    loadInitial();
  }, [currentUser.role]);

  useEffect(() => {
    const loadCounters = async () => {
      try {
        const qs = selectedLocationId ? `?locationId=${selectedLocationId}` : '';
        const res = await apiFetch<{ counters: UserOption[] }>(`/api/blind-sheet/counters${qs}`);
        setCounterOptions(res.counters);
        if (currentUser.role === UserRole.RESPONSABLE_DEPOSITO) {
          if (res.counters.length > 0) {
            setSelectedCounterId((prev) => {
              const stillValid = res.counters.some((c) => String(c.id) === prev);
              if (stillValid) return prev;
              setCounterName(res.counters[0].fullName);
              return String(res.counters[0].id);
            });
          } else {
            setSelectedCounterId('');
          }
        } else if (currentUser.role === UserRole.JEFE_STOCK) {
          setSelectedCounterId((prev) => {
            if (!prev || res.counters.some((c) => String(c.id) === prev)) return prev;
            return String(currentUser.id);
          });
        }
      } catch {
        // Optional suggestion list only
      }
    };
    loadCounters();
  }, [selectedLocationId, currentUser.role, currentUser.id]);

  useEffect(() => {
    if (!selectedLocationId && locations.length === 0) return;

    const loadCatalog = async () => {
      setLoadingCatalog(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (selectedLocationId) params.set('locationId', selectedLocationId);
        if (selectedFamily) params.set('family', selectedFamily);
        if (selectedRubro) params.set('rubro', selectedRubro);

        const res = await apiFetch<{
          items: BlindCatalogItem[];
          families: string[];
          rubros: string[];
        }>(`/api/blind-sheet/catalog?${params.toString()}`);

        setCatalogItems(res.items);
        setFamilies(res.families);
        setRubros(res.rubros);

        // Select all matching items by default when filter changes so the preview updates immediately
        setSelectedIds(res.items.map((it) => it.product_id));
        setSelectedSingleProductId('');
      } catch (err: unknown) {
        setError((err as Error).message);
        setCatalogItems([]);
        setSelectedIds([]);
      } finally {
        setLoadingCatalog(false);
      }
    };

    loadCatalog();
  }, [selectedLocationId, selectedFamily, selectedRubro, locations.length]);

  const resetSheetRegistrationIfNeeded = () => {
    if (registeredCount) {
      setRegisteredCount(null);
      setSheetMeta(createSheetIdentifier());
      setStatusMessage(null);
    }
  };

  const handleLocationChange = (locId: string) => {
    setSelectedLocationId(locId);
    setSelectedFamily('');
    setSelectedRubro('');
    setSelectedSingleProductId('');
    resetSheetRegistrationIfNeeded();
    const loc = locations.find((l) => String(l.id) === locId);
    setWarehouseManagerName(loc?.managerName || '');
  };

  const handleFamilyChange = (family: string) => {
    setSelectedFamily(family);
    setSelectedRubro('');
    setSelectedSingleProductId('');
    resetSheetRegistrationIfNeeded();
  };

  const handleSingleArticleChange = (productIdStr: string) => {
    setSelectedSingleProductId(productIdStr);
    resetSheetRegistrationIfNeeded();
    if (productIdStr) {
      setSelectedIds([Number(productIdStr)]);
    } else {
      setSelectedIds(visibleItems.map((it) => it.product_id));
    }
  };

  const visibleItems = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return catalogItems;
    return catalogItems.filter(
      (it) =>
        it.sku.toLowerCase().includes(q) ||
        it.description.toLowerCase().includes(q) ||
        it.alias.toLowerCase().includes(q)
    );
  }, [catalogItems, searchTerm]);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const sheetItems = useMemo(() => {
    if (selectedSingleProductId) {
      const pid = Number(selectedSingleProductId);
      return catalogItems.filter((it) => it.product_id === pid);
    }
    return visibleItems.filter((it) => selectedIdSet.has(it.product_id));
  }, [catalogItems, visibleItems, selectedIdSet, selectedSingleProductId]);

  const activeLocation = locations.find((l) => String(l.id) === selectedLocationId);
  const locationLabel = activeLocation
    ? activeLocation.name
    : locations.length > 1
      ? 'Todos los depósitos autorizados'
      : 'Sin ubicación';
  const locationGroupLabel = activeLocation ? activeLocation.groupType : 'CONSOLIDADO';

  const familyLabel = selectedFamily || 'Todas las familias';
  const rubroLabel = selectedRubro || 'Todos los rubros';

  const toggleItem = (productId: number) => {
    setSelectedSingleProductId('');
    resetSheetRegistrationIfNeeded();
    setSelectedIds((prev) =>
      prev.includes(productId) ? prev.filter((id) => id !== productId) : [...prev, productId]
    );
  };

  const selectAllVisible = () => {
    setSelectedSingleProductId('');
    resetSheetRegistrationIfNeeded();
    setSelectedIds(visibleItems.map((it) => it.product_id));
  };

  const clearSelection = () => {
    setSelectedSingleProductId('');
    resetSheetRegistrationIfNeeded();
    setSelectedIds([]);
  };

  const prepareNewSheet = () => {
    setRegisteredCount(null);
    setSheetMeta(createSheetIdentifier());
    setScheduledDate(getTodayIso());
    setScheduledTime(getCurrentTime());
    setStatusMessage(null);
    setError(null);
  };

  const resetFilters = () => {
    setSelectedFamily('');
    setSelectedRubro('');
    setSelectedSingleProductId('');
    setSearchTerm('');
    prepareNewSheet();
  };

  const logBlindSheetAction = async () => {
    try {
      await apiFetch('/api/blind-sheet/log-print', {
        method: 'POST',
        body: JSON.stringify({
          documentUid: sheetMeta.documentUid,
          countNumber: sheetMeta.countNumber,
          locationId: selectedLocationId ? Number(selectedLocationId) : undefined,
          family: familyLabel,
          rubro: rubroLabel,
          itemsCount: sheetItems.length,
        }),
      });
    } catch {
      // Do not block printing if audit log encounters transient error
    }
  };

  const registerValidatedCount = async (
    actionType: 'PRINT' | 'PDF'
  ): Promise<RegisteredCountInfo> => {
    if (!selectedLocationId) {
      throw new Error(
        'Para validar e ingresar el conteo a Gestión de Conteos y Conciliación, seleccione un Depósito / Ubicación específico en el paso 1.'
      );
    }
    const matchedCounter =
      selectedCounterId && Number(selectedCounterId) > 0
        ? Number(selectedCounterId)
        : counterOptions.find(
            (u) => u.fullName.trim().toLowerCase() === counterName.trim().toLowerCase()
          )?.id || null;

    const res = await apiFetch<{
      ok: boolean;
      alreadyRegistered: boolean;
      countId: number;
      countNumber: string;
      documentUid: string;
      status: string;
    }>('/api/blind-sheet/register-count', {
      method: 'POST',
      body: JSON.stringify({
        locationId: Number(selectedLocationId),
        scheduledDate,
        countNumber: sheetMeta.countNumber,
        documentUid: sheetMeta.documentUid,
        assignedCounterId: matchedCounter,
        productIds: sheetItems.map((it) => it.product_id),
        familyLabel,
        rubroLabel,
        actionType,
      }),
    });

    const info: RegisteredCountInfo = {
      countId: res.countId,
      countNumber: res.countNumber,
      documentUid: res.documentUid,
      status: res.status,
    };
    setSheetMeta({ countNumber: res.countNumber, documentUid: res.documentUid });
    setRegisteredCount(info);
    return info;
  };

  const handleValidateOnlyNow = async () => {
    if (sheetItems.length === 0) return;
    setRegistering(true);
    setError(null);
    setStatusMessage(null);
    try {
      const info = await registerValidatedCount('PRINT');
      setStatusMessage(
        `Planilla ${info.countNumber} validada e ingresada en Gestión de Conteos y Conteos y Conciliación (${sheetItems.length} artículo/s).`
      );
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setRegistering(false);
    }
  };

  const handleDownloadPdf = async () => {
    if (sheetItems.length === 0) return;
    setExporting(true);
    setStatusMessage(null);
    setError(null);
    try {
      let activeNumber = sheetMeta.countNumber;
      let activeUid = sheetMeta.documentUid;
      let regInfo: RegisteredCountInfo | null = null;

      if (registerOnEmit) {
        regInfo = await registerValidatedCount('PDF');
        activeNumber = regInfo.countNumber;
        activeUid = regInfo.documentUid;
      } else {
        await logBlindSheetAction();
      }

      await exportBlindCountSheetPdf({
        countNumber: activeNumber,
        documentUid: activeUid,
        scheduledDate,
        scheduledTime,
        locationName: locationLabel,
        locationGroup: locationGroupLabel,
        familyLabel,
        rubroLabel,
        counterName: counterName.trim() || currentUser.fullName,
        items: sheetItems.map((it) => ({
          sku: it.sku,
          description: it.description,
          unitOfMeasure: it.unit_of_measure,
          family: it.family,
          rubro: it.rubro,
        })),
      });

      if (regInfo) {
        setStatusMessage(
          `PDF ${regInfo.countNumber} descargado y validado en Gestión de Conteos y Conteos y Conciliación (${sheetItems.length} artículo/s).`
        );
      } else {
        setStatusMessage(
          `Planilla PDF ${activeNumber} descargada (${sheetItems.length} artículo/s).`
        );
      }
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const handleBrowserPrint = async () => {
    if (sheetItems.length === 0) return;
    setStatusMessage(null);
    setError(null);
    setRegistering(true);
    try {
      if (registerOnEmit) {
        const regInfo = await registerValidatedCount('PRINT');
        setStatusMessage(
          `Planilla ${regInfo.countNumber} validada e ingresada en Gestión de Conteos y Conteos y Conciliación (${sheetItems.length} artículo/s).`
        );
        // Allow React to paint the official count number on the sheet before opening print dialog
        await new Promise((resolve) => setTimeout(resolve, 60));
      } else {
        await logBlindSheetAction();
      }
      window.print();
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setRegistering(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Control Header & Actions (Hidden on print) */}
      <div className="no-print space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold text-slate-900">
              Planilla Imprimible de Conteo Ciego
            </h2>
            <p className="text-sm text-slate-600 mt-0.5">
              Seleccione depósito, familia, rubro y artículos para imprimir o descargar planillas físicas y validarlas directamente en Gestión de Conteos y Conciliación.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={resetFilters}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-white border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 whitespace-nowrap"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reiniciar Filtros
            </button>
            <button
              type="button"
              onClick={() => setRegisterOnEmit((prev) => !prev)}
              aria-pressed={registerOnEmit}
              title="Al activarlo, al imprimir o descargar en PDF la planilla ingresa validada a Gestión de Conteos y Conteos y Conciliación."
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border rounded-lg transition-colors whitespace-nowrap ${
                registerOnEmit
                  ? 'bg-emerald-50 border-emerald-600 text-emerald-900 hover:bg-emerald-100'
                  : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <ShieldCheck
                className={`w-3.5 h-3.5 ${registerOnEmit ? 'text-emerald-700' : 'text-slate-400'}`}
              />
              <span>
                Validar p/ Gestión y Conciliación: {registerOnEmit ? 'SÍ' : 'NO'}
              </span>
            </button>
            <button
              type="button"
              onClick={handleBrowserPrint}
              disabled={sheetItems.length === 0 || registering || exporting}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
            >
              <Printer className="w-3.5 h-3.5" />
              {registerOnEmit ? 'Imprimir y Validar' : 'Imprimir Planilla'}
            </button>
            <button
              type="button"
              onClick={handleDownloadPdf}
              disabled={sheetItems.length === 0 || exporting || registering}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-[#8e0d0d] text-white rounded-lg hover:bg-[#6e0909] disabled:opacity-50 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              {exporting
                ? 'Generando PDF...'
                : registerOnEmit
                  ? 'Descargar PDF y Validar'
                  : 'Descargar Planilla PDF'}
            </button>
          </div>
        </div>

        {statusMessage && (
          <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-900 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 font-medium">
              <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
              <span>{statusMessage}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!registeredCount && (
                <button
                  type="button"
                  onClick={handleValidateOnlyNow}
                  disabled={registering}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-emerald-700 text-white font-medium rounded-md hover:bg-emerald-800 disabled:opacity-50"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Validar e Ingresar Ahora
                </button>
              )}
              {registeredCount && onNavigateToManagement && (
                <button
                  type="button"
                  onClick={onNavigateToManagement}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-white border border-emerald-300 text-emerald-900 font-medium rounded-md hover:bg-emerald-100"
                >
                  <ClipboardList className="w-3.5 h-3.5" />
                  Ver en Gestión de Conteos
                </button>
              )}
              {registeredCount && onNavigateToWorkspace && (
                <button
                  type="button"
                  onClick={() => onNavigateToWorkspace(registeredCount.countId)}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-[#8e0d0d] text-white font-medium rounded-md hover:bg-[#6e0909]"
                >
                  <ArrowUpRight className="w-3.5 h-3.5" />
                  Ir a Conteos y Conciliación
                </button>
              )}
              {registeredCount && (
                <button
                  type="button"
                  onClick={prepareNewSheet}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-white border border-slate-300 text-slate-700 font-medium rounded-md hover:bg-slate-50"
                >
                  Nueva Planilla
                </button>
              )}
            </div>
          </div>
        )}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
            {error}
          </div>
        )}

        {/* Filter & Header Metadata Card */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                1. Depósito / Ubicación
              </label>
              <select
                value={selectedLocationId}
                onChange={(e) => handleLocationChange(e.target.value)}
                disabled={loadingLocations}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white text-slate-900"
              >
                {locations.length === 0 ? (
                  <option value="">Sin ubicaciones asignadas</option>
                ) : (
                  <>
                    {locations.length > 1 && <option value="">Todos los depósitos autorizados</option>}
                    {locations.map((loc) => (
                      <option key={loc.id} value={String(loc.id)}>
                        {loc.name} ({loc.groupType === 'CASA_CENTRAL' ? 'Casa Central' : 'Sucursal'})
                      </option>
                    ))}
                  </>
                )}
              </select>
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                2. Familia de Conteo
              </label>
              <select
                value={selectedFamily}
                onChange={(e) => handleFamilyChange(e.target.value)}
                disabled={loadingCatalog}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white text-slate-900"
              >
                <option value="">Todas las familias ({families.length})</option>
                {families.map((fam) => (
                  <option key={fam} value={fam}>
                    {fam}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                3. Rubro
              </label>
              <select
                value={selectedRubro}
                onChange={(e) => {
                  setSelectedRubro(e.target.value);
                  setSelectedSingleProductId('');
                }}
                disabled={loadingCatalog}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white text-slate-900"
              >
                <option value="">Todos los rubros ({rubros.length})</option>
                {rubros.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                4. Artículo Específico
              </label>
              <select
                value={selectedSingleProductId}
                onChange={(e) => handleSingleArticleChange(e.target.value)}
                disabled={loadingCatalog || catalogItems.length === 0}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white text-slate-900"
              >
                <option value="">Todos / Selección múltiple ({visibleItems.length})</option>
                {catalogItems.map((it) => (
                  <option key={it.product_id} value={String(it.product_id)}>
                    {it.sku} — {it.description}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 text-xs">
            <div>
              <label className="block font-semibold text-slate-700 mb-1">Nro. Planilla</label>
              <input
                type="text"
                value={sheetMeta.countNumber}
                onChange={(e) =>
                  setSheetMeta((prev) => ({ ...prev, countNumber: e.target.value }))
                }
                className="w-full px-3 py-1.5 border border-slate-300 rounded-lg font-mono"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">Fecha</label>
              <input
                type="date"
                value={scheduledDate}
                onChange={(e) => setScheduledDate(e.target.value)}
                className="w-full px-3 py-1.5 border border-slate-300 rounded-lg font-mono"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">Hora</label>
              <input
                type="time"
                value={scheduledTime}
                onChange={(e) => setScheduledTime(e.target.value)}
                className="w-full px-3 py-1.5 border border-slate-300 rounded-lg font-mono"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                Responsable de Conteo
              </label>
              {currentUser.role !== UserRole.CONTADOR && counterOptions.length > 0 ? (
                <select
                  value={selectedCounterId}
                  onChange={(e) => {
                    const val = e.target.value;
                    setSelectedCounterId(val);
                    const found = counterOptions.find((u) => String(u.id) === val);
                    if (found) setCounterName(found.fullName);
                    resetSheetRegistrationIfNeeded();
                  }}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded-lg bg-white text-slate-900"
                >
                  {currentUser.role === UserRole.RESPONSABLE_DEPOSITO && (
                    <option value="">Sin contador asignado</option>
                  )}
                  {counterOptions.map((u) => (
                    <option key={u.id} value={String(u.id)}>
                      {u.fullName}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={counterName}
                  onChange={(e) => setCounterName(e.target.value)}
                  placeholder="Nombre y apellido..."
                  className="w-full px-3 py-1.5 border border-slate-300 rounded-lg"
                />
              )}
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                Responsable de Depósito
              </label>
              <input
                type="text"
                value={warehouseManagerName}
                onChange={(e) => setWarehouseManagerName(e.target.value)}
                placeholder="A completar / firma en pie"
                className="w-full px-3 py-1.5 border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          {/* Search & Multi-select item list */}
          <div className="pt-4 border-t border-slate-100 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="relative flex-1 min-w-[240px]">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => {
                    setSearchTerm(e.target.value);
                    setSelectedSingleProductId('');
                  }}
                  placeholder="Buscar artículos por código, descripción o alias..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg"
                />
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-600 tabular-nums">
                  <strong>{sheetItems.length}</strong> de {visibleItems.length} artículos incluidos
                </span>
                <button
                  type="button"
                  onClick={selectAllVisible}
                  disabled={visibleItems.length === 0}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-slate-300 rounded-lg hover:bg-slate-50 text-slate-700 disabled:opacity-50 whitespace-nowrap"
                >
                  <CheckSquare className="w-3.5 h-3.5 text-[#8e0d0d]" />
                  Todos
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  disabled={selectedIds.length === 0}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-slate-300 rounded-lg hover:bg-slate-50 text-slate-700 disabled:opacity-50 whitespace-nowrap"
                >
                  <Square className="w-3.5 h-3.5" />
                  Ninguno
                </button>
              </div>
            </div>

            {loadingCatalog ? (
              <div className="p-6 text-center text-xs text-slate-500">
                Consultando artículos autorizados del depósito...
              </div>
            ) : visibleItems.length === 0 ? (
              <div className="p-6 bg-slate-50 border border-slate-200 rounded-lg text-center space-y-1">
                <FileSpreadsheet className="w-6 h-6 text-slate-400 mx-auto" />
                <div className="text-xs font-semibold text-slate-800">
                  No se encontraron artículos para la combinación seleccionada
                </div>
                <div className="text-[11px] text-slate-500">
                  Verifique que exista stock cargado desde Almacén Maestro en este depósito o amplíe los filtros de Familia/Rubro.
                </div>
              </div>
            ) : (
              <div className="border border-slate-200 rounded-lg max-h-52 overflow-y-auto divide-y divide-slate-100">
                {visibleItems.map((it) => {
                  const checked = selectedSingleProductId
                    ? Number(selectedSingleProductId) === it.product_id
                    : selectedIdSet.has(it.product_id);
                  return (
                    <label
                      key={`${it.location_id}-${it.product_id}`}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-slate-50 cursor-pointer"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleItem(it.product_id)}
                          className="rounded border-slate-300 text-[#8e0d0d] focus:ring-[#8e0d0d]"
                        />
                        <span className="font-mono font-semibold text-slate-900 shrink-0">
                          {it.sku}
                        </span>
                        <span className="text-slate-800 truncate">{it.description}</span>
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-slate-500 shrink-0">
                        <span>{it.family}</span>
                        <span>·</span>
                        <span>{it.rubro}</span>
                        <span className="font-mono text-slate-700">{it.unit_of_measure}</span>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-[#8e0d0d] shrink-0" />
          <span>
            <strong>Garantía de Conteo Ciego:</strong> Esta herramienta omite deliberadamente el stock teórico del ERP, stock comprometido y costos para asegurar imparcialidad en el relevamiento físico.
          </span>
        </div>
      </div>

      {/* Printable Blind Count Sheet Preview */}
      <div className="bg-white border border-slate-300 rounded-xl shadow-sm p-6 sm:p-8 print:border-0 print:shadow-none print:rounded-none print:p-0">
        {/* Sheet Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b-2 border-[#8e0d0d]">
          <div className="flex items-center gap-3.5">
            <img
              src={MERCOMAT_LOGO_URL}
              alt="MercoMat Logo"
              referrerPolicy="no-referrer"
              className="w-14 h-14 rounded-lg object-cover border border-slate-200 shrink-0"
            />
            <div>
              <h3 className="text-lg sm:text-xl font-bold text-[#8e0d0d] tracking-tight">
                MercoMat — Materiales para la Construcción
              </h3>
              <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide mt-0.5">
                Planilla de Conteo Físico Ciego (Sin Existencias Teóricas)
              </p>
            </div>
          </div>
          <div className="text-right text-xs font-mono text-slate-700">
            <div className="font-bold text-slate-900">{sheetMeta.countNumber}</div>
            <div className="text-[11px] text-slate-500">ID: {sheetMeta.documentUid}</div>
          </div>
        </div>
        <div className="h-1 bg-[#fbc016] mb-4" />

        {/* Relevant Count Metadata */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-xs mb-5 print:bg-white">
          <div>
            <span className="block text-[10px] font-semibold uppercase text-slate-500">Fecha</span>
            <span className="font-mono font-semibold text-slate-900 tabular-nums">
              {scheduledDate}
            </span>
          </div>
          <div>
            <span className="block text-[10px] font-semibold uppercase text-slate-500">Hora</span>
            <span className="font-mono font-semibold text-slate-900 tabular-nums">
              {scheduledTime} hs
            </span>
          </div>
          <div className="col-span-2">
            <span className="block text-[10px] font-semibold uppercase text-slate-500">
              Depósito / Ubicación
            </span>
            <span className="font-semibold text-slate-900">
              {locationLabel} ({locationGroupLabel === 'CASA_CENTRAL' ? 'Casa Central' : locationGroupLabel === 'SUCURSAL' ? 'Sucursal' : 'Consolidado'})
            </span>
          </div>
          <div>
            <span className="block text-[10px] font-semibold uppercase text-slate-500">
              Familia de Conteo
            </span>
            <span className="font-semibold text-slate-900">{familyLabel}</span>
          </div>
          <div>
            <span className="block text-[10px] font-semibold uppercase text-slate-500">Rubro</span>
            <span className="font-semibold text-slate-900">{rubroLabel}</span>
          </div>
          <div>
            <span className="block text-[10px] font-semibold uppercase text-slate-500">
              Responsable de Conteo
            </span>
            <span className="font-semibold text-slate-900">
              {counterName.trim() || currentUser.fullName}
            </span>
          </div>
          <div>
            <span className="block text-[10px] font-semibold uppercase text-slate-500">
              Artículos en Hoja
            </span>
            <span className="font-mono font-semibold text-slate-900 tabular-nums">
              {sheetItems.length} ítem(s)
            </span>
          </div>
        </div>

        {/* Blind Table with Unidades / Bultos and Unidades Sueltas */}
        {sheetItems.length === 0 ? (
          <div className="py-12 text-center text-xs text-slate-500 border border-dashed border-slate-300 rounded-lg">
            Seleccione al menos un artículo para previsualizar e imprimir la planilla de conteo ciego.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse border border-slate-300">
              <thead>
                <tr className="bg-[#8e0d0d] text-white text-left">
                  <th className="py-2.5 px-2.5 border border-[#8e0d0d] w-28">Código</th>
                  <th className="py-2.5 px-2.5 border border-[#8e0d0d]">
                    Descripción del Artículo
                  </th>
                  <th className="py-2.5 px-2 border border-[#8e0d0d] text-center w-14">U.M.</th>
                  <th className="py-2.5 px-2.5 border border-[#8e0d0d] text-center w-32">
                    Unidades / Bultos
                  </th>
                  <th className="py-2.5 px-2.5 border border-[#8e0d0d] text-center w-32">
                    Unidades Sueltas
                  </th>
                  <th className="py-2.5 px-2.5 border border-[#8e0d0d] w-40">Observaciones</th>
                </tr>
              </thead>
              <tbody>
                {sheetItems.map((it, idx) => (
                  <tr
                    key={`${it.location_id}-${it.product_id}`}
                    className={`print-break-inside-avoid ${
                      idx % 2 === 1 ? 'bg-slate-50/50 print:bg-white' : 'bg-white'
                    }`}
                  >
                    <td className="py-2.5 px-2.5 border border-slate-300 font-mono font-bold text-slate-900">
                      {it.sku}
                    </td>
                    <td className="py-2.5 px-2.5 border border-slate-300 text-slate-900">
                      <div className="font-medium">{it.description}</div>
                      <div className="text-[10px] text-slate-500">
                        {it.family} · {it.rubro}
                      </div>
                    </td>
                    <td className="py-2.5 px-2 border border-slate-300 text-center font-mono text-slate-700">
                      {it.unit_of_measure}
                    </td>
                    <td className="py-2.5 px-2.5 border border-slate-300 h-9" />
                    <td className="py-2.5 px-2.5 border border-slate-300 h-9" />
                    <td className="py-2.5 px-2.5 border border-slate-300 h-9" />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Footer Signatures */}
        <div className="mt-10 pt-4 print-break-inside-avoid">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            <div className="border border-slate-300 rounded-lg p-3.5 pt-14 text-center">
              <div className="border-t border-slate-400 pt-2">
                <div className="text-xs font-bold text-slate-900">
                  Firma Responsable del Conteo
                </div>
                <div className="text-[11px] text-slate-600 mt-0.5">
                  {counterName.trim() || currentUser.fullName}
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">Aclaración y DNI</div>
              </div>
            </div>

            <div className="border border-slate-300 rounded-lg p-3.5 pt-14 text-center">
              <div className="border-t border-slate-400 pt-2">
                <div className="text-xs font-bold text-slate-900">
                  Firma Responsable de Depósito
                </div>
                <div className="text-[11px] text-slate-600 mt-0.5">
                  {warehouseManagerName.trim() || 'Supervisión de Depósito'}
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">Aclaración y Sello</div>
              </div>
            </div>

            <div className="border border-slate-300 rounded-lg p-3.5 pt-14 text-center">
              <div className="border-t border-slate-400 pt-2">
                <div className="text-xs font-bold text-slate-900">
                  Validación Jefe de Control de Stock
                </div>
                <div className="text-[11px] text-slate-600 mt-0.5">Recepción y Auditoría</div>
                <div className="text-[10px] text-slate-400 mt-0.5">Fecha y Hora de Cierre</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
