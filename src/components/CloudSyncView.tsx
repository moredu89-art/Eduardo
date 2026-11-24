import React, { useEffect, useState } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import {
  CheckCircle2,
  CloudUpload,
  Database,
  LogOut,
  Trash2,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { auth } from '../lib/firebase';
import {
  CloudCatalogItem,
  CloudCatalogSnapshot,
  CloudCountRecord,
  deleteCloudSnapshot,
  ensureFirebaseWorkspace,
  subscribeCloudCatalogItems,
  subscribeCloudCountRecords,
  subscribeCloudSnapshots,
  syncInventoryAndCountsToCloud,
} from '../lib/firestoreSync';
import { firebaseGoogleSignIn, googleSignOut } from '../lib/googleAuth';
import { AuthUser } from '../types/erp';

export const CloudSyncView: React.FC<{ currentUser: AuthUser }> = ({ currentUser }) => {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(() => auth.currentUser);
  const [authReady, setAuthReady] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [snapshots, setSnapshots] = useState<CloudCatalogSnapshot[]>([]);
  const [cloudItems, setCloudItems] = useState<CloudCatalogItem[]>([]);
  const [cloudCounts, setCloudCounts] = useState<CloudCountRecord[]>([]);

  const [snapshotTitle, setSnapshotTitle] = useState(
    `Respaldo MercoMat ${new Date().toISOString().slice(0, 10)}`
  );
  const [summaryNotes, setSummaryNotes] = useState(
    `Sincronización consolidada ejecutada por ${currentUser.fullName}`
  );
  const [syncing, setSyncing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<'snapshots' | 'items' | 'counts'>('snapshots');

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      setAuthReady(true);
      if (user) {
        try {
          const wsId = await ensureFirebaseWorkspace(user);
          setWorkspaceId(wsId);
        } catch (err: unknown) {
          setError((err as Error).message || 'No se pudo inicializar el espacio en la nube.');
        }
      } else {
        setWorkspaceId(null);
        setSnapshots([]);
        setCloudItems([]);
        setCloudCounts([]);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!authReady || !firebaseUser || !workspaceId) return;

    const handleListenerError = (err: Error) => {
      setError(err.message);
    };

    const unsubSnaps = subscribeCloudSnapshots(
      workspaceId,
      firebaseUser.uid,
      setSnapshots,
      handleListenerError
    );
    const unsubItems = subscribeCloudCatalogItems(
      workspaceId,
      firebaseUser.uid,
      setCloudItems,
      handleListenerError
    );
    const unsubCounts = subscribeCloudCountRecords(
      workspaceId,
      firebaseUser.uid,
      setCloudCounts,
      handleListenerError
    );

    return () => {
      unsubSnaps();
      unsubItems();
      unsubCounts();
    };
  }, [authReady, firebaseUser, workspaceId]);

  const handleSignIn = async () => {
    setSigningIn(true);
    setError(null);
    try {
      const user = await firebaseGoogleSignIn();
      const wsId = await ensureFirebaseWorkspace(user);
      setWorkspaceId(wsId);
    } catch (err: unknown) {
      setError((err as Error).message || 'No se pudo iniciar sesión con Google.');
    } finally {
      setSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    await googleSignOut();
    setWorkspaceId(null);
    setSnapshots([]);
    setCloudItems([]);
    setCloudCounts([]);
    setStatusMessage(null);
  };

  const handleSyncNow = async () => {
    if (!firebaseUser) return;
    setSyncing(true);
    setError(null);
    setStatusMessage(null);
    try {
      const [invRes, countsRes, locRes] = await Promise.all([
        apiFetch<{ consolidated: Array<Record<string, unknown>> }>('/api/inventory'),
        apiFetch<{ counts: Array<Record<string, unknown>> }>('/api/counts'),
        apiFetch<{ locations: Array<Record<string, unknown>> }>('/api/locations'),
      ]);

      const result = await syncInventoryAndCountsToCloud({
        user: firebaseUser,
        title: snapshotTitle,
        summaryNotes,
        totalLocations: locRes.locations.length,
        consolidatedProducts: invRes.consolidated,
        counts: countsRes.counts,
      });

      setStatusMessage(
        `Respaldo sincronizado correctamente: ${result.syncedProducts} artículo(s) del Almacén Maestro y ${result.syncedCounts} registro(s) de conteo.`
      );
    } catch (err: unknown) {
      setError((err as Error).message || 'No se pudo completar la sincronización.');
    } finally {
      setSyncing(false);
    }
  };

  const handleDeleteSnapshot = async (snapshotId: string) => {
    if (!workspaceId) return;
    setError(null);
    try {
      await deleteCloudSnapshot(workspaceId, snapshotId);
      setStatusMessage('Respaldo eliminado correctamente.');
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">
            Respaldo y Sincronización en la Nube
          </h2>
          <p className="text-sm text-slate-600 mt-0.5">
            Conserve copias consolidadas del Almacén Maestro e historial de conteos accesibles desde cualquier sucursal y dispositivo.
          </p>
        </div>

        {firebaseUser && (
          <div className="flex items-center gap-3 bg-white border border-slate-200 rounded-lg px-3.5 py-2 text-xs">
            <div className="min-w-0">
              <div className="font-semibold text-slate-900 truncate">
                {firebaseUser.displayName || 'Cuenta conectada'}
              </div>
              <div className="text-[11px] text-slate-500 truncate">{firebaseUser.email}</div>
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border border-slate-300 text-slate-700 rounded-md hover:bg-slate-50 whitespace-nowrap"
            >
              <LogOut className="w-3.5 h-3.5" />
              Desconectar
            </button>
          </div>
        )}
      </div>

      {statusMessage && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{statusMessage}</span>
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
          {error.startsWith('{') && error.includes('"operationType"')
            ? 'Permisos insuficientes para completar la operación solicitada en la nube.'
            : error}
        </div>
      )}

      {!firebaseUser ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 max-w-2xl mx-auto text-center space-y-5">
          <div className="w-12 h-12 rounded-xl bg-red-50 border border-red-100 flex items-center justify-center mx-auto">
            <Database className="w-6 h-6 text-[#8e0d0d]" />
          </div>
          <div className="space-y-1.5">
            <h3 className="text-lg font-bold text-slate-900">
              Inicie sesión con Google para habilitar su espacio en la nube
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed max-w-lg mx-auto">
              Autentíquese con su cuenta de Google para respaldar inventarios del Almacén Maestro y consultar conteos históricos desde cualquier punto de la red MercoMat.
            </p>
          </div>

          <div className="flex justify-center pt-1">
            <button
              type="button"
              onClick={handleSignIn}
              disabled={signingIn}
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
                  {signingIn ? 'Conectando...' : 'Sign in with Google'}
                </span>
              </div>
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-bold text-slate-900">
              Generar Nuevo Respaldo Consolidado
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Nombre del Respaldo
                </label>
                <input
                  type="text"
                  maxLength={160}
                  value={snapshotTitle}
                  onChange={(e) => setSnapshotTitle(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Observaciones de Auditoría
                </label>
                <input
                  type="text"
                  maxLength={500}
                  value={summaryNotes}
                  onChange={(e) => setSummaryNotes(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleSyncNow}
                disabled={syncing || !snapshotTitle.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-[#8e0d0d] text-white rounded-lg hover:bg-[#6e0909] disabled:opacity-50"
              >
                <CloudUpload className="w-4 h-4" />
                {syncing ? 'Sincronizando...' : 'Sincronizar Inventario y Conteos'}
              </button>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => setActiveSubTab('snapshots')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                    activeSubTab === 'snapshots'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600'
                  }`}
                >
                  Respaldos ({snapshots.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveSubTab('items')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                    activeSubTab === 'items'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600'
                  }`}
                >
                  Almacén Maestro ({cloudItems.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveSubTab('counts')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                    activeSubTab === 'counts'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600'
                  }`}
                >
                  Conteos ({cloudCounts.length})
                </button>
              </div>
            </div>

            {activeSubTab === 'snapshots' && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-600">
                      <th className="py-2 px-3">Respaldo</th>
                      <th className="py-2 px-3 text-right">Artículos</th>
                      <th className="py-2 px-3 text-right">Ubicaciones</th>
                      <th className="py-2 px-3 text-right">Existencia Física</th>
                      <th className="py-2 px-3">Notas</th>
                      <th className="py-2 px-3 text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshots.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-slate-500">
                          Aún no hay respaldos registrados en su espacio en la nube.
                        </td>
                      </tr>
                    ) : (
                      snapshots.map((snap) => (
                        <tr key={snap.id} className="border-b border-slate-100">
                          <td className="py-2.5 px-3 font-semibold text-slate-900">
                            {snap.title}
                            <div className="text-[11px] font-normal text-slate-500">
                              {new Date(snap.createdAtMs).toLocaleString()}
                            </div>
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono">{snap.totalProducts}</td>
                          <td className="py-2.5 px-3 text-right font-mono">{snap.totalLocations}</td>
                          <td className="py-2.5 px-3 text-right font-mono">
                            {snap.totalPhysicalStock.toLocaleString()}
                          </td>
                          <td className="py-2.5 px-3 text-slate-600 max-w-[260px] truncate">
                            {snap.summaryNotes}
                          </td>
                          <td className="py-2.5 px-3 text-right">
                            <button
                              type="button"
                              onClick={() => handleDeleteSnapshot(snap.id)}
                              className="inline-flex items-center gap-1 px-2 py-1 text-red-700 hover:bg-red-50 rounded"
                              title="Eliminar respaldo"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {activeSubTab === 'items' && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-600">
                      <th className="py-2 px-3">Código</th>
                      <th className="py-2 px-3">Descripción</th>
                      <th className="py-2 px-3">Familia</th>
                      <th className="py-2 px-3 text-right">ERP Físico</th>
                      <th className="py-2 px-3 text-right">Comprometido</th>
                      <th className="py-2 px-3 text-right">Disponible</th>
                      <th className="py-2 px-3">Criticidad</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cloudItems.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-500">
                          Ejecute una sincronización para almacenar los artículos del Almacén Maestro.
                        </td>
                      </tr>
                    ) : (
                      cloudItems.map((it) => (
                        <tr key={it.id} className="border-b border-slate-100">
                          <td className="py-2 px-3 font-mono font-semibold text-slate-900">
                            {it.sku}
                          </td>
                          <td className="py-2 px-3 text-slate-800">{it.description}</td>
                          <td className="py-2 px-3 text-slate-600">{it.family}</td>
                          <td className="py-2 px-3 text-right font-mono">{it.totalErpPhysical}</td>
                          <td className="py-2 px-3 text-right font-mono">{it.totalCommitted}</td>
                          <td className="py-2 px-3 text-right font-mono font-semibold text-emerald-700">
                            {it.totalAvailable}
                          </td>
                          <td className="py-2 px-3">{it.criticalityLevel}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {activeSubTab === 'counts' && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-600">
                      <th className="py-2 px-3">Nro. Conteo</th>
                      <th className="py-2 px-3">Ubicación</th>
                      <th className="py-2 px-3">Fecha</th>
                      <th className="py-2 px-3">Responsable</th>
                      <th className="py-2 px-3 text-right">Ítems</th>
                      <th className="py-2 px-3 text-right">Diferencias</th>
                      <th className="py-2 px-3">Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cloudCounts.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-500">
                          Sin conteos sincronizados en la nube todavía.
                        </td>
                      </tr>
                    ) : (
                      cloudCounts.map((c) => (
                        <tr key={c.id} className="border-b border-slate-100">
                          <td className="py-2 px-3 font-mono font-semibold text-slate-900">
                            {c.countNumber}
                          </td>
                          <td className="py-2 px-3 text-slate-800">{c.locationName}</td>
                          <td className="py-2 px-3 font-mono text-slate-600">{c.scheduledDate}</td>
                          <td className="py-2 px-3 text-slate-700">{c.counterName}</td>
                          <td className="py-2 px-3 text-right font-mono">{c.itemsCount}</td>
                          <td className="py-2 px-3 text-right font-mono">{c.discrepanciesCount}</td>
                          <td className="py-2 px-3">{c.status}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
