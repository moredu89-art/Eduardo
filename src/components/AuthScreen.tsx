import React, { useState } from 'react';
import { Lock, ShieldCheck, User } from 'lucide-react';
import { apiFetch, setAuthToken } from '../lib/api';
import { MERCOMAT_LOGO_URL } from '../lib/pdfExport';
import { AuthUser } from '../types/erp';

interface AuthScreenProps {
  needsBootstrap: boolean;
  onAuthenticated: (user: AuthUser) => void;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({ needsBootstrap, onAuthenticated }) => {
  const [username, setUsername] = useState(needsBootstrap ? 'jefe.stock' : '');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (needsBootstrap && password !== confirmPassword) {
      setError('Las contraseñas ingresadas no coinciden.');
      return;
    }

    setLoading(true);
    try {
      if (needsBootstrap) {
        const res = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/bootstrap', {
          method: 'POST',
          body: JSON.stringify({ username, fullName, email, password }),
        });
        setAuthToken(res.token);
        onAuthenticated(res.user);
      } else {
        const res = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        setAuthToken(res.token);
        onAuthenticated(res.user);
      }
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center px-4 py-12">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="bg-[#8e0d0d] px-8 py-6 flex items-center gap-4 border-b-4 border-[#fbc016]">
          <img
            src={MERCOMAT_LOGO_URL}
            alt="Logo MercoMat"
            referrerPolicy="no-referrer"
            className="w-14 h-14 rounded-lg object-cover shrink-0 border border-white/20"
          />
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">
              Merco<span className="text-[#fbc016]">Mat</span>
            </h1>
            <p className="text-xs text-red-100 mt-0.5">
              Control de Inventarios · 11 Ubicaciones · Punto de Venta
            </p>
          </div>
        </div>

        <div className="p-8">
          {needsBootstrap ? (
            <div className="mb-6 pb-4 border-b border-slate-200">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#8e0d0d] mb-1">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                <span>Configuración Inicial del Sistema</span>
              </div>
              <p className="text-xs text-slate-600 leading-relaxed">
                Registre la cuenta principal del <strong>Jefe de Control de Stock</strong>. Luego
                podrá dar de alta a los tres Responsables de Conteo y al Responsable de Depósito
                desde el módulo de usuarios.
              </p>
            </div>
          ) : (
            <div className="mb-6 pb-4 border-b border-slate-200">
              <h2 className="text-base font-semibold text-slate-900">Acceso al Sistema</h2>
              <p className="text-xs text-slate-500 mt-1">
                Ingrese sus credenciales asignadas. Todas las operaciones quedan registradas en
                auditoría.
              </p>
            </div>
          )}

          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Usuario</label>
              <div className="relative">
                <User className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="ej. jefe.stock"
                  className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#8e0d0d] focus:border-[#8e0d0d]"
                />
              </div>
            </div>

            {needsBootstrap && (
              <>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Nombre y Apellido
                  </label>
                  <input
                    type="text"
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Nombre completo del Jefe de Control de Stock"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#8e0d0d]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Correo Institucional (opcional)
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="control.stock@mercomat.com"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#8e0d0d]"
                  />
                </div>
              </>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Contraseña</label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Mínimo 6 caracteres"
                  className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#8e0d0d]"
                />
              </div>
            </div>

            {needsBootstrap && (
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Confirmar Contraseña
                </label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repita la contraseña"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#8e0d0d]"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 bg-[#8e0d0d] hover:bg-[#6e0909] disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors whitespace-nowrap"
            >
              {loading
                ? 'Verificando...'
                : needsBootstrap
                  ? 'Inicializar Sistema y Acceder'
                  : 'Iniciar Sesión'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
