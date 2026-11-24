import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Download,
  KeyRound,
  Pencil,
  Plus,
  Shield,
  Upload,
  UserCheck,
  UserX,
} from 'lucide-react';
import { apiDownload, apiFetch } from '../lib/api';
import { AuthUser, UserRole } from '../types/erp';

export const UsersAuditView: React.FC<{ currentUser: AuthUser }> = ({ currentUser }) => {
  const isReadOnlyAudit = currentUser.role === UserRole.AUDITORIA_DIRECCION;
  const [tab, setTab] = useState<'users' | 'audit'>(isReadOnlyAudit ? 'audit' : 'users');
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [locations, setLocations] = useState<Array<{ id: number; name: string }>>([]);
  const [availableFamilies, setAvailableFamilies] = useState<string[]>([]);
  const [events, setEvents] = useState<Array<Record<string, unknown>>>([]);
  const [showNewUser, setShowNewUser] = useState(false);
  const [editTarget, setEditTarget] = useState<AuthUser | null>(null);
  const [resetTarget, setResetTarget] = useState<AuthUser | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [restorePreview, setRestorePreview] = useState<{
    filename: string;
    payload: Record<string, unknown>;
    valid: boolean;
    errors: string[];
    warnings: string[];
    summary: {
      backupVersion: number;
      exportedAt: string;
      totalTables: number;
      totalRows: number;
      attachmentFilesCount: number;
      checksumMatch: boolean;
    } | null;
  } | null>(null);
  const [restoring, setRestoring] = useState(false);

  const [form, setForm] = useState({
    username: '',
    fullName: '',
    email: '',
    role: UserRole.CONTADOR as UserRole,
    password: '',
    assignedLocationIds: [] as number[],
    assignedFamilies: [] as string[],
  });
  const [newCustomFamily, setNewCustomFamily] = useState('');

  const [editForm, setEditForm] = useState({
    fullName: '',
    role: UserRole.CONTADOR as UserRole,
    assignedLocationIds: [] as number[],
    assignedFamilies: [] as string[],
  });
  const [editCustomFamily, setEditCustomFamily] = useState('');

  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    setError(null);
    try {
      if (isReadOnlyAudit) {
        const aRes = await apiFetch<{ events: Array<Record<string, unknown>> }>('/api/audit');
        setEvents(aRes.events);
        return;
      }
      const [uRes, lRes, aRes, fRes] = await Promise.all([
        apiFetch<{ users: AuthUser[] }>('/api/users'),
        apiFetch<{ locations: Array<{ id: number; name: string }> }>('/api/locations'),
        apiFetch<{ events: Array<Record<string, unknown>> }>('/api/audit'),
        apiFetch<{ families: string[] }>('/api/products/families'),
      ]);
      setUsers(uRes.users);
      setLocations(lRes.locations);
      setEvents(aRes.events);
      setAvailableFamilies(fRes.families);
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const allFamilyOptions = useMemo(() => {
    const set = new Set<string>(availableFamilies);
    form.assignedFamilies.forEach((f) => set.add(f));
    editForm.assignedFamilies.forEach((f) => set.add(f));
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'es'));
  }, [availableFamilies, form.assignedFamilies, editForm.assignedFamilies]);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          assignedLocationIds:
            form.role === UserRole.JEFE_STOCK || form.role === UserRole.AUDITORIA_DIRECCION
              ? []
              : form.assignedLocationIds,
          assignedFamilies:
            form.role === UserRole.CONTADOR ? form.assignedFamilies : [],
        }),
      });
      setShowNewUser(false);
      setForm({
        username: '',
        fullName: '',
        email: '',
        role: UserRole.CONTADOR,
        password: '',
        assignedLocationIds: [],
        assignedFamilies: [],
      });
      setNewCustomFamily('');
      setMessage('Usuario creado con contraseña cifrada (scrypt), depósitos y familias de conteo asignadas.');
      await loadData();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const openEditModal = (u: AuthUser) => {
    setError(null);
    setEditTarget(u);
    setEditForm({
      fullName: u.fullName,
      role: u.role,
      assignedLocationIds: [...u.assignedLocationIds],
      assignedFamilies: [...(u.assignedFamilies || [])],
    });
    setEditCustomFamily('');
  };

  const handleUpdateAssignments = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editTarget) return;
    setError(null);
    try {
      await apiFetch(`/api/users/${editTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          fullName: editForm.fullName,
          role: editForm.role,
          assignedLocationIds:
            editForm.role === UserRole.JEFE_STOCK || editForm.role === UserRole.AUDITORIA_DIRECCION
              ? []
              : editForm.assignedLocationIds,
          assignedFamilies:
            editForm.role === UserRole.CONTADOR ? editForm.assignedFamilies : [],
        }),
      });
      setEditTarget(null);
      setMessage(`Asignación de depósito y familia actualizada para ${editTarget.fullName}.`);
      await loadData();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const handleToggleActive = async (u: AuthUser) => {
    setError(null);
    try {
      await apiFetch(`/api/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !u.isActive }),
      });
      await loadData();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetTarget) return;
    setError(null);
    try {
      await apiFetch(`/api/users/${resetTarget.id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ newPassword }),
      });
      setResetTarget(null);
      setNewPassword('');
      setMessage(`Contraseña restablecida para ${resetTarget.username}.`);
      await loadData();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const addCustomFamilyToCreate = () => {
    const clean = newCustomFamily.trim();
    if (!clean) return;
    if (!form.assignedFamilies.includes(clean)) {
      setForm({ ...form, assignedFamilies: [...form.assignedFamilies, clean] });
    }
    setNewCustomFamily('');
  };

  const addCustomFamilyToEdit = () => {
    const clean = editCustomFamily.trim();
    if (!clean) return;
    if (!editForm.assignedFamilies.includes(clean)) {
      setEditForm({ ...editForm, assignedFamilies: [...editForm.assignedFamilies, clean] });
    }
    setEditCustomFamily('');
  };

  const handleSelectBackupFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setMessage(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const verifyRes = await apiFetch<{
        valid: boolean;
        errors: string[];
        warnings: string[];
        summary: {
          backupVersion: number;
          exportedAt: string;
          totalTables: number;
          totalRows: number;
          attachmentFilesCount: number;
          checksumMatch: boolean;
        } | null;
      }>('/api/admin/backup/verify', {
        method: 'POST',
        body: JSON.stringify(parsed),
      });
      setRestorePreview({
        filename: file.name,
        payload: parsed,
        ...verifyRes,
      });
    } catch (err: unknown) {
      setError((err as Error).message || 'No se pudo verificar el archivo de respaldo.');
    }
  };

  const handleConfirmRestore = async () => {
    if (!restorePreview || !restorePreview.valid) return;
    setRestoring(true);
    setError(null);
    try {
      const res = await apiFetch<{
        restoredTables: number;
        restoredRows: number;
        restoredAttachmentFiles: number;
        usersRequiringPasswordReset: string[];
      }>('/api/admin/restore', {
        method: 'POST',
        body: JSON.stringify({ backup: restorePreview.payload, confirmRestore: true }),
      });
      setRestorePreview(null);
      const resetNotice =
        res.usersRequiringPasswordReset.length > 0
          ? ` Restablezca la contraseña de los usuarios nuevos: ${res.usersRequiringPasswordReset.join(', ')}.`
          : '';
      setMessage(
        `Respaldo restaurado (${res.restoredTables} tablas, ${res.restoredRows} filas, ${res.restoredAttachmentFiles} archivo(s) adjunto(s)).${resetNotice}`
      );
      await loadData();
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">
            Usuarios, Permisos, Auditoría y Respaldos
          </h2>
          <p className="text-sm text-slate-600 mt-0.5">
            Asignación de depósitos y familias de conteo para responsables, control de roles y auditoría inmutable.
          </p>
        </div>

        {!isReadOnlyAudit && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() =>
                apiDownload(
                  '/api/admin/backup',
                  `SICEP_Respaldo_${new Date().toISOString().slice(0, 10)}.json`
                )
              }
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-slate-300 bg-white text-slate-800 rounded-lg hover:bg-slate-50 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              Descargar Copia de Seguridad
            </button>
            <label className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-slate-300 bg-white text-slate-800 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap">
              <Upload className="w-3.5 h-3.5" />
              Verificar / Restaurar Respaldo
              <input
                type="file"
                accept="application/json,.json"
                onChange={handleSelectBackupFile}
                className="hidden"
              />
            </label>
            <button
              onClick={() => setShowNewUser(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-[#8e0d0d] text-white rounded-lg hover:bg-[#6e0909] whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              Nuevo Usuario
            </button>
          </div>
        )}
      </div>

      {message && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800">
          {message}
        </div>
      )}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        {!isReadOnlyAudit && (
          <button
            onClick={() => setTab('users')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md ${
              tab === 'users' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            Cuentas de Usuario ({users.length})
          </button>
        )}
        <button
          onClick={() => setTab('audit')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md ${
            tab === 'audit' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
          }`}
        >
          Registro de Auditoría Inmutable ({events.length})
        </button>
      </div>

      {tab === 'users' ? (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
                <th className="py-2.5 px-3">Usuario</th>
                <th className="py-2.5 px-3">Nombre Completo</th>
                <th className="py-2.5 px-3">Rol</th>
                <th className="py-2.5 px-3">Depósitos Asignados</th>
                <th className="py-2.5 px-3">Familias de Conteo</th>
                <th className="py-2.5 px-3">Estado</th>
                <th className="py-2.5 px-3">Último Acceso</th>
                <th className="py-2.5 px-3">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-slate-100">
                  <td className="py-2.5 px-3 font-mono font-semibold text-slate-900">
                    {u.username}
                  </td>
                  <td className="py-2.5 px-3">{u.fullName}</td>
                  <td className="py-2.5 px-3 font-medium">
                    {u.role === UserRole.JEFE_STOCK
                      ? 'Jefe de Control de Stock'
                      : u.role === UserRole.AUDITORIA_DIRECCION
                        ? 'Dirección / Auditoría Interna (Solo Lectura)'
                        : u.role === UserRole.CONTADOR
                          ? 'Responsable de Conteo'
                          : 'Responsable de Depósito'}
                  </td>
                  <td className="py-2.5 px-3 text-slate-600">
                    {u.role === UserRole.JEFE_STOCK
                      ? 'Todos (Acceso Global)'
                      : u.role === UserRole.AUDITORIA_DIRECCION
                        ? 'Todos (Solo Lectura Global)'
                        : u.assignedLocationIds.length === 0
                          ? 'Sin ubicaciones asignadas'
                          : u.assignedLocationIds
                              .map((id) => locations.find((l) => l.id === id)?.name || `#${id}`)
                              .join(', ')}
                  </td>
                  <td className="py-2.5 px-3 text-slate-600">
                    {u.role === UserRole.CONTADOR
                      ? u.assignedFamilies && u.assignedFamilies.length > 0
                        ? u.assignedFamilies.join(', ')
                        : 'Todas las familias'
                      : '—'}
                  </td>
                  <td className="py-2.5 px-3">
                    <span className={u.isActive ? 'text-emerald-700 font-medium' : 'text-red-700'}>
                      {u.isActive ? 'Activo' : 'Deshabilitado'}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 font-mono text-slate-500">
                    {u.lastLoginAt ? u.lastLoginAt.slice(0, 16) : 'Nunca'}
                  </td>
                  <td className="py-2.5 px-3 flex items-center gap-3 whitespace-nowrap">
                    <button
                      onClick={() => openEditModal(u)}
                      className="inline-flex items-center gap-1 text-slate-800 font-medium hover:underline"
                    >
                      <Pencil className="w-3.5 h-3.5 text-[#8e0d0d]" />
                      Depósito / Familia
                    </button>
                    <button
                      onClick={() => setResetTarget(u)}
                      className="inline-flex items-center gap-1 text-blue-700 hover:underline"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                      Clave
                    </button>
                    {u.id !== currentUser.id && (
                      <button
                        onClick={() => handleToggleActive(u)}
                        className={`inline-flex items-center gap-1 hover:underline ${
                          u.isActive ? 'text-red-700' : 'text-emerald-700'
                        }`}
                      >
                        {u.isActive ? <UserX className="w-3.5 h-3.5" /> : <UserCheck className="w-3.5 h-3.5" />}
                        {u.isActive ? 'Baja' : 'Activar'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
                <th className="py-2.5 px-3">Fecha/Hora</th>
                <th className="py-2.5 px-3">Usuario</th>
                <th className="py-2.5 px-3">Operación</th>
                <th className="py-2.5 px-3">Entidad</th>
                <th className="py-2.5 px-3">Detalle / Cambios</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={String(ev.id)} className="border-b border-slate-100">
                  <td className="py-2 px-3 font-mono text-slate-500 whitespace-nowrap">
                    {String(ev.created_at)}
                  </td>
                  <td className="py-2 px-3 font-mono font-medium">{String(ev.username)}</td>
                  <td className="py-2 px-3 font-semibold text-slate-900">{String(ev.action)}</td>
                  <td className="py-2 px-3 font-mono">
                    {String(ev.entity_type)} #{String(ev.entity_id)}
                  </td>
                  <td className="py-2 px-3 font-mono text-[11px] text-slate-600 max-w-md truncate">
                    {ev.old_value_json ? `Ant: ${String(ev.old_value_json)} | ` : ''}
                    {ev.new_value_json ? `Nuevo: ${String(ev.new_value_json)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* New User Modal */}
      {showNewUser && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-xl max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center gap-2 text-base font-bold text-slate-900 mb-4">
              <Shield className="w-4 h-4 text-[#8e0d0d]" />
              <span>Alta de Usuario y Asignación de Depósito / Familia</span>
            </div>
            <form onSubmit={handleCreateUser} className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Usuario *</label>
                  <input
                    type="text"
                    required
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                    placeholder="ej. contador1"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Rol *</label>
                  <select
                    value={form.role}
                    onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                  >
                    <option value={UserRole.CONTADOR}>Responsable de Conteo</option>
                    <option value={UserRole.RESPONSABLE_DEPOSITO}>Responsable de Depósito</option>
                    <option value={UserRole.AUDITORIA_DIRECCION}>
                      Dirección / Auditoría Interna (Solo Lectura)
                    </option>
                    <option value={UserRole.JEFE_STOCK}>Jefe de Control de Stock</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Nombre Completo *</label>
                  <input
                    type="text"
                    required
                    value={form.fullName}
                    onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    Contraseña Inicial *
                  </label>
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              {form.role === UserRole.AUDITORIA_DIRECCION && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700">
                  <strong>Supervisión Ejecutiva de Solo Lectura:</strong> Acceso global al tablero de control, conteos activos por contador, planificados pendientes del mes, conteos cerrados, Almacén Maestro, ubicaciones y auditoría inmutable. No puede crear, modificar ni aprobar inventarios.
                </div>
              )}

              {form.role !== UserRole.JEFE_STOCK && form.role !== UserRole.AUDITORIA_DIRECCION && (
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    Depósitos / Sucursales Asignadas
                  </label>
                  <div className="grid grid-cols-2 gap-1.5 max-h-36 overflow-y-auto border border-slate-200 rounded-lg p-2.5">
                    {locations.map((l) => {
                      const checked = form.assignedLocationIds.includes(l.id);
                      return (
                        <label key={l.id} className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setForm({
                                  ...form,
                                  assignedLocationIds: [...form.assignedLocationIds, l.id],
                                });
                              } else {
                                setForm({
                                  ...form,
                                  assignedLocationIds: form.assignedLocationIds.filter(
                                    (id) => id !== l.id
                                  ),
                                });
                              }
                            }}
                          />
                          <span>{l.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {form.role === UserRole.CONTADOR && (
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    Familias Asignadas para Conteo (desde Almacén Maestro)
                  </label>
                  <p className="text-[11px] text-slate-500 mb-2">
                    Si no marca ninguna familia, el usuario podrá contar todas las familias dentro de sus depósitos asignados.
                  </p>
                  {allFamilyOptions.length > 0 && (
                    <div className="grid grid-cols-2 gap-1.5 max-h-36 overflow-y-auto border border-slate-200 rounded-lg p-2.5 mb-2">
                      {allFamilyOptions.map((fam) => {
                        const checked = form.assignedFamilies.includes(fam);
                        return (
                          <label key={fam} className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setForm({
                                    ...form,
                                    assignedFamilies: [...form.assignedFamilies, fam],
                                  });
                                } else {
                                  setForm({
                                    ...form,
                                    assignedFamilies: form.assignedFamilies.filter((f) => f !== fam),
                                  });
                                }
                              }}
                            />
                            <span className="truncate">{fam}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newCustomFamily}
                      onChange={(e) => setNewCustomFamily(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addCustomFamilyToCreate();
                        }
                      }}
                      placeholder="Agregar familia manualmente (ej. Ferretería, Sanitarios)..."
                      className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg"
                    />
                    <button
                      type="button"
                      onClick={addCustomFamilyToCreate}
                      className="px-3 py-1.5 border border-slate-300 rounded-lg bg-slate-50 hover:bg-slate-100 font-medium"
                    >
                      Agregar
                    </button>
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewUser(false)}
                  className="px-4 py-2 border border-slate-300 rounded-lg"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-[#8e0d0d] text-white rounded-lg font-medium hover:bg-[#6e0909]"
                >
                  Crear Usuario
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Assignments Modal */}
      {editTarget && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-xl max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center gap-2 text-base font-bold text-slate-900 mb-1">
              <Pencil className="w-4 h-4 text-[#8e0d0d]" />
              <span>Asignación de Depósito y Familia para Conteo</span>
            </div>
            <p className="text-xs text-slate-500 mb-4">
              Usuario: <strong>{editTarget.username}</strong> ({editTarget.fullName})
            </p>
            <form onSubmit={handleUpdateAssignments} className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Nombre Completo</label>
                  <input
                    type="text"
                    required
                    value={editForm.fullName}
                    onChange={(e) => setEditForm({ ...editForm, fullName: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Rol</label>
                  <select
                    value={editForm.role}
                    onChange={(e) => setEditForm({ ...editForm, role: e.target.value as UserRole })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                  >
                    <option value={UserRole.CONTADOR}>Responsable de Conteo</option>
                    <option value={UserRole.RESPONSABLE_DEPOSITO}>Responsable de Depósito</option>
                    <option value={UserRole.AUDITORIA_DIRECCION}>
                      Dirección / Auditoría Interna (Solo Lectura)
                    </option>
                    <option value={UserRole.JEFE_STOCK}>Jefe de Control de Stock</option>
                  </select>
                </div>
              </div>

              {editForm.role === UserRole.AUDITORIA_DIRECCION && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700">
                  <strong>Supervisión Ejecutiva de Solo Lectura:</strong> Acceso global de lectura en todas las ubicaciones sin permisos de modificación.
                </div>
              )}

              {editForm.role !== UserRole.JEFE_STOCK && editForm.role !== UserRole.AUDITORIA_DIRECCION && (
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    Depósitos / Sucursales Asignadas
                  </label>
                  <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto border border-slate-200 rounded-lg p-2.5">
                    {locations.map((l) => {
                      const checked = editForm.assignedLocationIds.includes(l.id);
                      return (
                        <label key={l.id} className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setEditForm({
                                  ...editForm,
                                  assignedLocationIds: [...editForm.assignedLocationIds, l.id],
                                });
                              } else {
                                setEditForm({
                                  ...editForm,
                                  assignedLocationIds: editForm.assignedLocationIds.filter(
                                    (id) => id !== l.id
                                  ),
                                });
                              }
                            }}
                          />
                          <span>{l.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {editForm.role === UserRole.CONTADOR && (
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    Familias Asignadas para Conteo
                  </label>
                  <p className="text-[11px] text-slate-500 mb-2">
                    Seleccione las familias del Almacén Maestro asignadas a este responsable de conteo.
                  </p>
                  {allFamilyOptions.length > 0 && (
                    <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto border border-slate-200 rounded-lg p-2.5 mb-2">
                      {allFamilyOptions.map((fam) => {
                        const checked = editForm.assignedFamilies.includes(fam);
                        return (
                          <label key={fam} className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setEditForm({
                                    ...editForm,
                                    assignedFamilies: [...editForm.assignedFamilies, fam],
                                  });
                                } else {
                                  setEditForm({
                                    ...editForm,
                                    assignedFamilies: editForm.assignedFamilies.filter(
                                      (f) => f !== fam
                                    ),
                                  });
                                }
                              }}
                            />
                            <span className="truncate">{fam}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={editCustomFamily}
                      onChange={(e) => setEditCustomFamily(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addCustomFamilyToEdit();
                        }
                      }}
                      placeholder="Agregar familia manualmente..."
                      className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg"
                    />
                    <button
                      type="button"
                      onClick={addCustomFamilyToEdit}
                      className="px-3 py-1.5 border border-slate-300 rounded-lg bg-slate-50 hover:bg-slate-100 font-medium"
                    >
                      Agregar
                    </button>
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditTarget(null)}
                  className="px-4 py-2 border border-slate-300 rounded-lg"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-[#8e0d0d] text-white rounded-lg font-medium hover:bg-[#6e0909]"
                >
                  Guardar Asignación
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Password Reset Modal */}
      {resetTarget && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-sm p-6">
            <h3 className="text-base font-bold text-slate-900 mb-1">Restablecer Contraseña</h3>
            <p className="text-xs text-slate-500 mb-4">
              Usuario: <strong>{resetTarget.username}</strong> ({resetTarget.fullName})
            </p>
            <form onSubmit={handleResetPassword} className="space-y-4 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Nueva Contraseña (mín. 6 caracteres)
                </label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setResetTarget(null)}
                  className="px-4 py-2 border border-slate-300 rounded-lg"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-slate-900 text-white rounded-lg font-medium"
                >
                  Actualizar Clave
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Backup Verification & Restore Modal */}
      {restorePreview && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4 text-xs">
            <div className="flex items-center gap-2 text-base font-bold text-slate-900">
              <CheckCircle2
                className={`w-5 h-5 ${restorePreview.valid ? 'text-emerald-700' : 'text-red-700'}`}
              />
              <span>Verificación de Respaldo SICEP</span>
            </div>
            <div className="text-slate-600">
              Archivo: <span className="font-mono font-semibold">{restorePreview.filename}</span>
            </div>

            {restorePreview.summary && (
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-1">
                <div>
                  Versión: <strong className="font-mono">v{restorePreview.summary.backupVersion}</strong> ·{' '}
                  Exportado: <span className="font-mono">{restorePreview.summary.exportedAt.slice(0, 19)}</span>
                </div>
                <div>
                  Tablas: <strong>{restorePreview.summary.totalTables}</strong> · Filas totales:{' '}
                  <strong>{restorePreview.summary.totalRows}</strong> · Adjuntos:{' '}
                  <strong>{restorePreview.summary.attachmentFilesCount}</strong>
                </div>
                <div>
                  Integridad SHA-256:{' '}
                  <strong className={restorePreview.summary.checksumMatch ? 'text-emerald-700' : 'text-red-700'}>
                    {restorePreview.summary.checksumMatch ? 'Verificada' : 'Inválida'}
                  </strong>
                </div>
              </div>
            )}

            {restorePreview.warnings.length > 0 && (
              <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-amber-900">
                {restorePreview.warnings.map((w, idx) => (
                  <div key={idx}>{w}</div>
                ))}
              </div>
            )}

            {restorePreview.errors.length > 0 && (
              <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-red-700">
                {restorePreview.errors.map((errMsg, idx) => (
                  <div key={idx}>{errMsg}</div>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setRestorePreview(null)}
                className="px-4 py-2 border border-slate-300 rounded-lg"
              >
                Cerrar
              </button>
              {restorePreview.valid && (
                <button
                  type="button"
                  disabled={restoring}
                  onClick={handleConfirmRestore}
                  className="px-4 py-2 bg-[#8e0d0d] text-white rounded-lg font-medium hover:bg-[#6e0909] disabled:opacity-50"
                >
                  {restoring ? 'Restaurando...' : 'Confirmar Restauración'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

