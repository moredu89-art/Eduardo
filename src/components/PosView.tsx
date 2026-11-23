import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FileSpreadsheet,
  Plus,
  Printer,
  Search,
  ShoppingCart,
  Trash2,
  XCircle,
} from 'lucide-react';
import { apiDownload, apiFetch } from '../lib/api';
import { exportPosVoucherPdf } from '../lib/pdfExport';
import { AuthUser, PosOperationStatus, PosOperationType, UserRole } from '../types/erp';

interface PosCatalogItem {
  product_id: number;
  sku: string;
  description: string;
  alias: string;
  unit_of_measure: string;
  sale_price: number | null;
  location_id: number;
  location_name: string;
  erp_physical_stock: number;
  committed_stock: number;
  pos_pending_sync: number;
  available_stock: number;
}

interface CartLine {
  productId: number;
  sku: string;
  description: string;
  quantity: number;
  unitPrice: number;
  maxAvailable: number;
}

export const PosView: React.FC<{ currentUser: AuthUser }> = ({ currentUser }) => {
  const [locations, setLocations] = useState<Array<{ id: number; name: string }>>([]);
  const [locationId, setLocationId] = useState<string>('');
  const [search, setSearch] = useState('');
  const [catalog, setCatalog] = useState<PosCatalogItem[]>([]);
  const [operations, setOperations] = useState<Array<Record<string, unknown>>>([]);

  const [opType, setOpType] = useState<PosOperationType>(PosOperationType.VENTA);
  const [customerName, setCustomerName] = useState('Consumidor Final');
  const [customerDoc, setCustomerDoc] = useState('');
  const [notes, setNotes] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);

  const [voidTargetId, setVoidTargetId] = useState<number | null>(null);
  const [voidReason, setVoidReason] = useState('');

  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPosData = async () => {
    setLoading(true);
    setError(null);
    try {
      const locRes = await apiFetch<{ locations: Array<{ id: number; name: string }> }>('/api/locations');
      setLocations(locRes.locations);
      const effectiveLoc = locationId || (locRes.locations[0] ? String(locRes.locations[0].id) : '');
      if (!locationId && effectiveLoc) setLocationId(effectiveLoc);

      const qs = new URLSearchParams();
      if (effectiveLoc) qs.set('locationId', effectiveLoc);
      if (search) qs.set('search', search);

      const [catRes, opsRes] = await Promise.all([
        apiFetch<{ catalog: PosCatalogItem[] }>(`/api/pos/catalog?${qs}`),
        apiFetch<{ operations: Array<Record<string, unknown>> }>(`/api/pos/operations?${qs}`),
      ]);
      setCatalog(catRes.catalog);
      setOperations(opsRes.operations);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPosData();
  }, [locationId]);

  const addToCart = (item: PosCatalogItem) => {
    setError(null);
    if (
      (opType === PosOperationType.VENTA || opType === PosOperationType.RESERVA) &&
      item.available_stock <= 0
    ) {
      setError(`El artículo ${item.sku} no posee stock disponible en ${item.location_name}.`);
      return;
    }

    const existing = cart.find((c) => c.productId === item.product_id);
    if (existing) {
      setCart(
        cart.map((c) =>
          c.productId === item.product_id ? { ...c, quantity: c.quantity + 1 } : c
        )
      );
    } else {
      setCart([
        ...cart,
        {
          productId: item.product_id,
          sku: item.sku,
          description: item.description,
          quantity: 1,
          unitPrice: item.sale_price ?? 0,
          maxAvailable: item.available_stock,
        },
      ]);
    }
  };

  const handleSubmitOperation = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (!locationId || cart.length === 0) {
      setError('Seleccione una ubicación y agregue al menos un artículo al comprobante.');
      return;
    }

    try {
      const res = await apiFetch<{ operationNumber: string; status: string; total: number }>(
        '/api/pos/operations',
        {
          method: 'POST',
          body: JSON.stringify({
            operationType: opType,
            locationId: Number(locationId),
            customerName,
            customerDoc,
            notes,
            items: cart.map((c) => ({
              productId: c.productId,
              quantity: c.quantity,
              unitPrice: c.unitPrice,
            })),
          }),
        }
      );

      setCart([]);
      setNotes('');
      setMessage(
        `Operación ${res.operationNumber} (${opType}) registrada con estado ${res.status}.`
      );
      await loadPosData();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const handleConfirmReservation = async (id: number) => {
    setError(null);
    try {
      await apiFetch(`/api/pos/operations/${id}/confirm`, { method: 'POST' });
      setMessage('Reserva confirmada como venta y movimiento de salida generado.');
      await loadPosData();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const handleVoidOperation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!voidTargetId) return;
    setError(null);
    try {
      await apiFetch(`/api/pos/operations/${voidTargetId}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason: voidReason }),
      });
      setVoidTargetId(null);
      setVoidReason('');
      setMessage('Operación anulada y existencias revertidas con trazabilidad completa.');
      await loadPosData();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const cartTotal = cart.reduce((sum, c) => sum + c.quantity * c.unitPrice, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Punto de Venta (POS) Integrado</h2>
          <p className="text-sm text-slate-600 mt-0.5">
            Módulo comercial local conectado al Almacén Maestro. Emite comprobantes internos no fiscales y exporta movimientos hacia el ERP.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={locationId}
            onChange={(e) => {
              setLocationId(e.target.value);
              setCart([]);
            }}
            className="px-3 py-2 text-xs font-medium border border-slate-300 rounded-lg bg-white"
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          {currentUser.role === UserRole.JEFE_STOCK && (
            <button
              onClick={() => apiDownload('/api/pos/export-erp', 'Movimientos_POS_Para_ERP.xlsx')}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-50 whitespace-nowrap"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              Exportar Movimientos ERP
            </button>
          )}
        </div>
      </div>

      {message && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          {message}
        </div>
      )}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Catalog */}
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex items-center justify-between gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadPosData()}
                placeholder="Buscar por código, descripción o alias..."
                className="w-full pl-9 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg"
              />
            </div>
            <button
              onClick={loadPosData}
              className="px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-lg"
            >
              Buscar
            </button>
          </div>

          {loading ? (
            <div className="p-8 text-center text-xs text-slate-500">Cargando catálogo...</div>
          ) : catalog.length === 0 ? (
            <div className="p-10 text-center text-xs text-slate-500">
              No hay artículos con existencia en esta ubicación. Importe el Excel del ERP en el Almacén Maestro.
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[420px]">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600 sticky top-0">
                    <th className="py-2 px-3">Código</th>
                    <th className="py-2 px-3">Descripción</th>
                    <th className="py-2 px-3 text-right">Disponible</th>
                    <th className="py-2 px-3 text-right">Compr.</th>
                    <th className="py-2 px-3 text-right">Precio</th>
                    <th className="py-2 px-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {catalog.map((it) => (
                    <tr key={it.product_id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="py-2 px-3 font-mono font-semibold text-slate-900">
                        {it.sku}
                      </td>
                      <td className="py-2 px-3">
                        <div className="font-medium text-slate-900">{it.description}</div>
                        <div className="text-[11px] text-slate-500">{it.unit_of_measure}</div>
                      </td>
                      <td
                        className={`py-2 px-3 text-right font-mono font-bold tabular-nums ${
                          it.available_stock > 0 ? 'text-emerald-700' : 'text-red-700'
                        }`}
                      >
                        {it.available_stock}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums text-amber-700">
                        {it.committed_stock}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">
                        {it.sale_price !== null
                          ? `$${it.sale_price.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`
                          : '$0.00'}
                      </td>
                      <td className="py-2 px-3 text-right">
                        <button
                          onClick={() => addToCart(it)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-slate-900 text-white rounded hover:bg-slate-800"
                        >
                          <Plus className="w-3 h-3" />
                          Agregar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Cart / Operation Form */}
        <form
          onSubmit={handleSubmitOperation}
          className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
        >
          <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <ShoppingCart className="w-4 h-4 text-[#8e0d0d]" />
            <span>Nueva Operación Comercial</span>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {[
              [PosOperationType.VENTA, 'Venta'],
              [PosOperationType.RESERVA, 'Reserva'],
              [PosOperationType.DEVOLUCION, 'Devolución'],
            ].map(([type, label]) => (
              <button
                key={type}
                type="button"
                onClick={() => setOpType(type as PosOperationType)}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md ${
                  opType === type ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <label className="block text-slate-600 mb-1">Cliente</label>
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-slate-600 mb-1">DNI / CUIT</label>
              <input
                type="text"
                value={customerDoc}
                onChange={(e) => setCustomerDoc(e.target.value)}
                className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg font-mono"
              />
            </div>
          </div>

          <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-52 overflow-y-auto">
            {cart.length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-500">
                Agregue artículos desde el catálogo.
              </div>
            ) : (
              cart.map((line) => (
                <div key={line.productId} className="p-2.5 text-xs space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-semibold text-slate-900">{line.sku}</span>
                    <button
                      type="button"
                      onClick={() => setCart(cart.filter((c) => c.productId !== line.productId))}
                      className="text-red-600 hover:text-red-800"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="text-[11px] text-slate-600 truncate">{line.description}</div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0.01}
                      step="any"
                      value={line.quantity}
                      onChange={(e) =>
                        setCart(
                          cart.map((c) =>
                            c.productId === line.productId
                              ? { ...c, quantity: Number(e.target.value) }
                              : c
                          )
                        )
                      }
                      className="w-20 px-2 py-1 border border-slate-300 rounded font-mono text-right"
                    />
                    <span className="text-slate-500">x $</span>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={line.unitPrice}
                      onChange={(e) =>
                        setCart(
                          cart.map((c) =>
                            c.productId === line.productId
                              ? { ...c, unitPrice: Number(e.target.value) }
                              : c
                          )
                        )
                      }
                      className="w-24 px-2 py-1 border border-slate-300 rounded font-mono text-right"
                    />
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="text-xs">
            <label className="block text-slate-600 mb-1">
              Documentación / Observaciones{' '}
              {opType === PosOperationType.DEVOLUCION && <span className="text-red-600">*</span>}
            </label>
            <input
              type="text"
              required={opType === PosOperationType.DEVOLUCION}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={
                opType === PosOperationType.DEVOLUCION
                  ? 'Nro comprobante origen y motivo obligatorio'
                  : 'Observación opcional'
              }
              className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg"
            />
          </div>

          <div className="pt-2 border-t border-slate-200 flex items-center justify-between">
            <span className="text-xs text-slate-500">Total Interno:</span>
            <span className="text-lg font-mono font-bold text-slate-900 tabular-nums">
              ${cartTotal.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
            </span>
          </div>

          <button
            type="submit"
            disabled={cart.length === 0}
            className="w-full py-2.5 bg-[#8e0d0d] hover:bg-[#6e0909] text-white text-xs font-semibold rounded-lg disabled:opacity-50"
          >
            Registrar {opType}
          </button>
        </form>
      </div>

      {/* Operations History */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 text-sm font-bold text-slate-900">
          Registro de Operaciones POS y Pendientes ({operations.length})
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
                <th className="py-2.5 px-3">Nro Operación</th>
                <th className="py-2.5 px-3">Tipo</th>
                <th className="py-2.5 px-3">Estado</th>
                <th className="py-2.5 px-3">Cliente</th>
                <th className="py-2.5 px-3 text-right">Total</th>
                <th className="py-2.5 px-3">Fecha</th>
                <th className="py-2.5 px-3">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {operations.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-500">
                    Sin operaciones registradas en esta ubicación.
                  </td>
                </tr>
              ) : (
                operations.map((op) => (
                  <tr key={String(op.id)} className="border-b border-slate-100">
                    <td className="py-2.5 px-3 font-mono font-semibold text-slate-900">
                      {String(op.operation_number)}
                    </td>
                    <td className="py-2.5 px-3 font-medium">{String(op.operation_type)}</td>
                    <td className="py-2.5 px-3">
                      <span
                        className={
                          op.status === PosOperationStatus.ANULADA
                            ? 'text-red-700 font-medium'
                            : op.status === PosOperationStatus.PENDIENTE
                              ? 'text-amber-700 font-medium'
                              : 'text-emerald-700 font-medium'
                        }
                      >
                        {String(op.status)}
                      </span>
                    </td>
                    <td className="py-2.5 px-3">{String(op.customer_name)}</td>
                    <td className="py-2.5 px-3 text-right font-mono font-semibold tabular-nums">
                      ${Number(op.total).toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-slate-500">
                      {String(op.created_at).slice(0, 16)}
                    </td>
                    <td className="py-2.5 px-3 flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => {
                          void exportPosVoucherPdf(op as never);
                        }}
                        className="inline-flex items-center gap-1 text-slate-700 hover:text-[#8e0d0d]"
                      >
                        <Printer className="w-3.5 h-3.5" />
                        PDF
                      </button>
                      {op.status === PosOperationStatus.PENDIENTE &&
                        op.operation_type === PosOperationType.RESERVA && (
                          <button
                            onClick={() => handleConfirmReservation(Number(op.id))}
                            className="text-blue-700 hover:underline font-medium"
                          >
                            Confirmar Venta
                          </button>
                        )}
                      {op.status !== PosOperationStatus.ANULADA && (
                        <button
                          onClick={() => setVoidTargetId(Number(op.id))}
                          className="inline-flex items-center gap-1 text-red-700 hover:underline"
                        >
                          <XCircle className="w-3.5 h-3.5" />
                          Anular
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Void Modal */}
      {voidTargetId && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6">
            <h3 className="text-base font-bold text-slate-900 mb-2">Anular Operación POS</h3>
            <form onSubmit={handleVoidOperation} className="space-y-4 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Motivo de Anulación (Trazabilidad Obligatoria) *
                </label>
                <textarea
                  required
                  rows={3}
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setVoidTargetId(null)}
                  className="px-4 py-2 border border-slate-300 rounded-lg"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-red-700 text-white rounded-lg font-medium"
                >
                  Confirmar Anulación
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
