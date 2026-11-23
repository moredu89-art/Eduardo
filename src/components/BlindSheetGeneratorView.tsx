import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckSquare,
  Download,
  FileSpreadsheet,
  Printer,
  RotateCcw,
  Search,
  ShieldAlert,
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
  role: UserRole;
  isActive: boolean;
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

export const BlindSheetGeneratorView: React.FC<{ currentUser: AuthUser }> = ({ currentUser }) => {
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
  const [warehouseManagerName, setWarehouseManagerName] = useState<string>('');
  const [sheetMeta, setSheetMeta] = useState(createSheetIdentifier);
  const [counterOptions, setCounterOptions] = useState<UserOption[]>([]);

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
        if (currentUser.role === UserRole.JEFE_STOCK) {
          try {
            const usersRes = await apiFetch<{ users: UserOption[] }>('/api/users');
            setCounterOptions(usersRes.users.filter((u) => u.isActive));
          } catch {
            // Optional suggestion list only
          }
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

  const handleLocationChange = (locId: string) => {
    setSelectedLocationId(locId);
    setSelectedFamily('');
    setSelectedRubro('');
    setSelectedSingleProductId('');
    const loc = locations.find((l) => String(l.id) === locId);
    setWarehouseManagerName(loc?.managerName || '');
  };

  const handleFamilyChange = (family: string) => {
    setSelectedFamily(family);
    setSelectedRubro('');
    setSelectedSingleProductId('');
  };

  const handleSingleArticleChange = (productIdStr: string) => {
    setSelectedSingleProductId(productIdStr);
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
    setSelectedIds((prev) =>
      prev.includes(productId) ? prev.filter((id) => id !== productId) : [...prev, productId]
    );
  };

  const selectAllVisible = () => {
    setSelectedSingleProductId('');
    setSelectedIds(visibleItems.map((it) => it.product_id));
  };

  const clearSelection = () => {
    setSelectedSingleProductId('');
    setSelectedIds([]);
  };

  const resetFilters = () => {
    setSelectedFamily('');
    setSelectedRubro('');
    setSelectedSingleProductId('');
    setSearchTerm('');
    setSheetMeta(createSheetIdentifier());
    setScheduledDate(getTodayIso());
    setScheduledTime(getCurrentTime());
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

  const handleDownloadPdf = async () => {
    if (sheetItems.length === 0) return;
    setExporting(true);
    setStatusMessage(null);
    setError(null);
    try {
      await logBlindSheetAction();
      await exportBlindCountSheetPdf({
        countNumber: sheetMeta.countNumber,
        documentUid: sheetMeta.documentUid,
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
      setStatusMessage(
        `Planilla PDF ${sheetMeta.countNumber} descargada (${sheetItems.length} artículo/s).`
      );
      setSheetMeta(createSheetIdentifier());
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const handleBrowserPrint = async () => {
    if (sheetItems.length === 0) return;
    setStatusMessage(null);
    await logBlindSheetAction();
    window.print();
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
              Seleccione depósito, familia, rubro y artículos para imprimir planillas físicas con columnas de bultos y unidades sueltas, sin exponer existencias teóricas.
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
              onClick={handleBrowserPrint}
              disabled={sheetItems.length === 0}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
            >
              <Printer className="w-3.5 h-3.5" />
              Imprimir Planilla
            </button>
            <button
              type="button"
              onClick={handleDownloadPdf}
              disabled={sheetItems.length === 0 || exporting}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-[#8e0d0d] text-white rounded-lg hover:bg-[#6e0909] disabled:opacity-50 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              {exporting ? 'Generando PDF...' : 'Descargar Planilla PDF'}
            </button>
          </div>
        </div>

        {statusMessage && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800">
            {statusMessage}
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
              <input
                type="text"
                list="blind-counter-options"
                value={counterName}
                onChange={(e) => setCounterName(e.target.value)}
                placeholder="Nombre y apellido..."
                className="w-full px-3 py-1.5 border border-slate-300 rounded-lg"
              />
              {counterOptions.length > 0 && (
                <datalist id="blind-counter-options">
                  {counterOptions.map((u) => (
                    <option key={u.id} value={u.fullName} />
                  ))}
                </datalist>
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
