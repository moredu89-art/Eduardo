import React, { useEffect, useState } from 'react';
import { Building2, ChevronRight, MapPin, Plus, Warehouse, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { AuthUser, LocationGroup, UserRole } from '../types/erp';

interface LocationSummary {
  id: number;
  code: string;
  name: string;
  groupType: LocationGroup;
  address: string;
  managerUserId: number | null;
  managerName: string | null;
  isActive: boolean;
  skusCount: number;
  totalErpStock: number;
  totalAvailableStock: number;
  openCounts: number;
  totalDiscrepancies: number;
  reliabilityPct: number | null;
}

interface LocationDetailResponse {
  location: Record<string, unknown>;
  inventory: Array<Record<string, unknown>>;
  countHistory: Array<Record<string, unknown>>;
  discrepancyHistory: Array<Record<string, unknown>>;
  movementHistory: Array<Record<string, unknown>>;
}

export const LocationsView: React.FC<{ currentUser: AuthUser }> = ({ currentUser }) => {
  const [locations, setLocations] = useState<LocationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedLocId, setSelectedLocId] = useState<number | null>(null);
  const [detail, setDetail] = useState<LocationDetailResponse | null>(null);
  const [detailTab, setDetailTab] = useState<'inventory' | 'counts' | 'discrepancies' | 'movements'>('inventory');
  const [showNewModal, setShowNewModal] = useState(false);
  const [managers, setManagers] = useState<AuthUser[]>([]);
  const [form, setForm] = useState({
    code: '',
    name: '',
    groupType: LocationGroup.SUCURSAL,
    address: '',
    managerUserId: '',
  });
  const [error, setError] = useState<string | null>(null);

  const loadLocations = async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ locations: LocationSummary[] }>('/api/locations');
      setLocations(res.locations);
      if (currentUser.role === UserRole.JEFE_STOCK) {
        const uRes = await apiFetch<{ users: AuthUser[] }>('/api/users');
        setManagers(uRes.users.filter((u) => u.isActive));
      }
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLocations();
  }, []);

  const openDetail = async (id: number) => {
    setSelectedLocId(id);
    setDetailTab(currentUser.role === UserRole.CONTADOR ? 'counts' : 'inventory');
    try {
      const res = await apiFetch<LocationDetailResponse>(`/api/locations/${id}/detail`);
      setDetail(res);
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const handleCreateLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/locations', {
        method: 'POST',
        body: JSON.stringify({
          code: form.code,
          name: form.name,
          groupType: form.groupType,
          address: form.address,
          managerUserId: form.managerUserId ? Number(form.managerUserId) : null,
        }),
      });
      setShowNewModal(false);
      setForm({ code: '', name: '', groupType: LocationGroup.SUCURSAL, address: '', managerUserId: '' });
      await loadLocations();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const casaCentral = locations.filter((l) => l.groupType === LocationGroup.CASA_CENTRAL);
  const sucursales = locations.filter((l) => l.groupType === LocationGroup.SUCURSAL);

  const renderLocationGrid = (title: string, icon: React.ReactNode, list: LocationSummary[]) => (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        {icon}
        <span>{title}</span>
        <span className="text-xs font-normal text-slate-500">· {list.length} ubicaciones</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {list.map((loc) => (
          <button
            key={loc.id}
            onClick={() => openDetail(loc.id)}
            className={`text-left bg-white border rounded-xl p-4 transition-colors hover:border-slate-400 ${
              selectedLocId === loc.id ? 'border-[#8e0d0d] ring-1 ring-[#8e0d0d]' : 'border-slate-200'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-xs font-mono text-slate-500">
                  {loc.code} · {loc.managerName || 'Sin responsable asignado'}
                </div>
                <h3 className="text-base font-semibold text-slate-900 mt-0.5">{loc.name}</h3>
                {loc.address && <p className="text-xs text-slate-500 mt-0.5">{loc.address}</p>}
              </div>
              <ChevronRight className="w-4 h-4 text-slate-400 shrink-0 mt-1" />
            </div>

            <div className="mt-4 pt-3 border-t border-slate-100 grid grid-cols-3 gap-2 text-xs">
              <div>
                <div className="text-slate-500">Artículos</div>
                <div className="font-mono font-semibold text-slate-900 tabular-nums">
                  {currentUser.role === UserRole.CONTADOR ? 'Ciego' : loc.skusCount}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Conteos Abiertos</div>
                <div className="font-mono font-semibold text-slate-900 tabular-nums">
                  {loc.openCounts}
                </div>
              </div>
              <div>
                <div className="text-slate-500">Confiabilidad</div>
                <div className="font-mono font-semibold text-slate-900 tabular-nums">
                  {loc.reliabilityPct !== null ? `${loc.reliabilityPct}%` : 'Sin datos'}
                </div>
              </div>
            </div>
          </button>
        ))}
      </div>
    </section>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Ubicaciones, Depósitos y Sucursales</h2>
          <p className="text-sm text-slate-600 mt-0.5">
            Administración individualizada de Casa Central y Sucursales desde una única base centralizada.
          </p>
        </div>
        {currentUser.role === UserRole.JEFE_STOCK && (
          <button
            onClick={() => setShowNewModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#8e0d0d] hover:bg-[#6e0909] text-white text-sm font-medium rounded-lg transition-colors whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            Nueva Ubicación
          </button>
        )}
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-36 bg-white border border-slate-200 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="space-y-8">
          {casaCentral.length > 0 &&
            renderLocationGrid('Casa Central', <Warehouse className="w-4 h-4 text-slate-700" />, casaCentral)}
          {sucursales.length > 0 &&
            renderLocationGrid('Sucursales', <Building2 className="w-4 h-4 text-slate-700" />, sucursales)}
        </div>
      )}

      {detail && selectedLocId && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <MapPin className="w-5 h-5 text-[#8e0d0d]" />
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  {String(detail.location.name)} · {String(detail.location.code)}
                </h3>
                <p className="text-xs text-slate-500">
                  Responsable: {String(detail.location.manager_name || 'Sin asignar')} ·{' '}
                  {String(detail.location.address || 'Sin dirección')}
                </p>
              </div>
            </div>
            <button
              onClick={() => {
                setSelectedLocId(null);
                setDetail(null);
              }}
              className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100"
              aria-label="Cerrar detalle"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-5 py-2 border-b border-slate-200 flex items-center gap-1 bg-slate-50 overflow-x-auto">
            {currentUser.role !== UserRole.CONTADOR && (
              <button
                onClick={() => setDetailTab('inventory')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                  detailTab === 'inventory' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                Inventario Individual ({detail.inventory.length})
              </button>
            )}
            <button
              onClick={() => setDetailTab('counts')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                detailTab === 'counts' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              Historial de Conteos ({detail.countHistory.length})
            </button>
            {currentUser.role !== UserRole.CONTADOR && (
              <>
                <button
                  onClick={() => setDetailTab('discrepancies')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                    detailTab === 'discrepancies' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                  }`}
                >
                  Diferencias y Ajustes ({detail.discrepancyHistory.length})
                </button>
                <button
                  onClick={() => setDetailTab('movements')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                    detailTab === 'movements' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                  }`}
                >
                  Movimientos ({detail.movementHistory.length})
                </button>
              </>
            )}
          </div>

          <div className="p-5 overflow-x-auto">
            {detailTab === 'inventory' && (
              detail.inventory.length === 0 ? (
                <p className="text-sm text-slate-500">
                  Esta ubicación aún no registra artículos importados desde el ERP.
                </p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500 text-left">
                      <th className="py-2 pr-3">Código</th>
                      <th className="py-2 pr-3">Descripción</th>
                      <th className="py-2 pr-3 text-right">ERP Físico</th>
                      <th className="py-2 pr-3 text-right">Comprometido</th>
                      <th className="py-2 pr-3 text-right">Disponible</th>
                      <th className="py-2">Últ. Conteo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.inventory.map((row) => (
                      <tr key={String(row.product_id)} className="border-b border-slate-100">
                        <td className="py-2 pr-3 font-mono font-medium">{String(row.sku)}</td>
                        <td className="py-2 pr-3">{String(row.description)}</td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums">
                          {Number(row.erp_physical_stock)}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums">
                          {Number(row.committed_stock)}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono font-semibold tabular-nums">
                          {Number(row.available_stock)}
                        </td>
                        <td className="py-2 font-mono text-slate-500">
                          {row.last_counted_at ? String(row.last_counted_at).slice(0, 10) : 'Pendiente'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}

            {detailTab === 'counts' && (
              detail.countHistory.length === 0 ? (
                <p className="text-sm text-slate-500">No hay conteos registrados para esta ubicación.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500 text-left">
                      <th className="py-2 pr-3">Nro Conteo</th>
                      <th className="py-2 pr-3">Fecha Prog.</th>
                      <th className="py-2 pr-3">Responsable</th>
                      <th className="py-2 pr-3">Estado</th>
                      <th className="py-2">Firma Depósito</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.countHistory.map((c) => (
                      <tr key={String(c.id)} className="border-b border-slate-100">
                        <td className="py-2 pr-3 font-mono font-medium">{String(c.count_number)}</td>
                        <td className="py-2 pr-3 font-mono">{String(c.scheduled_date)}</td>
                        <td className="py-2 pr-3">{String(c.counter_name)}</td>
                        <td className="py-2 pr-3 font-medium">{String(c.status)}</td>
                        <td className="py-2 text-slate-600">
                          {c.warehouse_signature_name ? String(c.warehouse_signature_name) : 'Sin firma'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}

            {detailTab === 'discrepancies' && (
              detail.discrepancyHistory.length === 0 ? (
                <p className="text-sm text-slate-500">Sin diferencias registradas en esta ubicación.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500 text-left">
                      <th className="py-2 pr-3">Conteo</th>
                      <th className="py-2 pr-3">Código</th>
                      <th className="py-2 pr-3">Artículo</th>
                      <th className="py-2 pr-3 text-right">ERP</th>
                      <th className="py-2 pr-3 text-right">Físico</th>
                      <th className="py-2 pr-3 text-right">Diferencia</th>
                      <th className="py-2 pr-3">Regularización</th>
                      <th className="py-2">Nro Op. ERP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.discrepancyHistory.map((d, i) => (
                      <tr key={i} className="border-b border-slate-100">
                        <td className="py-2 pr-3 font-mono">{String(d.count_number)}</td>
                        <td className="py-2 pr-3 font-mono">{String(d.sku)}</td>
                        <td className="py-2 pr-3">{String(d.description)}</td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums">{Number(d.snapshot_erp_stock)}</td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums">{Number(d.final_counted_qty)}</td>
                        <td className="py-2 pr-3 text-right font-mono font-semibold tabular-nums text-red-700">
                          {Number(d.difference)}
                        </td>
                        <td className="py-2 pr-3">{String(d.adjustment_status)}</td>
                        <td className="py-2 font-mono">{String(d.erp_operation_number || '—')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}

            {detailTab === 'movements' && (
              detail.movementHistory.length === 0 ? (
                <p className="text-sm text-slate-500">Sin movimientos registrados.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500 text-left">
                      <th className="py-2 pr-3">Fecha</th>
                      <th className="py-2 pr-3">Tipo</th>
                      <th className="py-2 pr-3">Código</th>
                      <th className="py-2 pr-3 text-right">Variación</th>
                      <th className="py-2">Detalle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.movementHistory.map((m) => (
                      <tr key={String(m.id)} className="border-b border-slate-100">
                        <td className="py-2 pr-3 font-mono text-slate-500">{String(m.created_at)}</td>
                        <td className="py-2 pr-3 font-medium">{String(m.movement_type)}</td>
                        <td className="py-2 pr-3 font-mono">{String(m.sku)}</td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums">
                          {Number(m.quantity_delta) > 0 ? `+${m.quantity_delta}` : Number(m.quantity_delta)}
                        </td>
                        <td className="py-2 text-slate-600">{String(m.notes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}
          </div>
        </div>
      )}

      {showNewModal && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-slate-900">Incorporar Nueva Ubicación</h3>
              <button onClick={() => setShowNewModal(false)} className="p-1 text-slate-500 hover:text-slate-900">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateLocation} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Código Interno</label>
                <input
                  type="text"
                  required
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  placeholder="ej. CC-D8 o SUC-NOR"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Nombre</label>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="ej. Depósito 8 / Sucursal Norte"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Estructura</label>
                <select
                  value={form.groupType}
                  onChange={(e) => setForm({ ...form, groupType: e.target.value as LocationGroup })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value={LocationGroup.CASA_CENTRAL}>Casa Central</option>
                  <option value={LocationGroup.SUCURSAL}>Sucursal</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Dirección / Sector</label>
                <input
                  type="text"
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Responsable Asignado</label>
                <select
                  value={form.managerUserId}
                  onChange={(e) => setForm({ ...form, managerUserId: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="">Sin asignar</option>
                  {managers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.fullName} ({m.role})
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewModal(false)}
                  className="px-4 py-2 text-sm text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg"
                >
                  Crear Ubicación
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
