import React, { useEffect, useState } from 'react';
import {
  BarChart3,
  Bell,
  BrainCircuit,
  ClipboardCheck,
  Database,
  FileCheck2,
  ListChecks,
  LogOut,
  MapPin,
  Menu,
  Printer,
  Shield,
  ShoppingCart,
  X,
} from 'lucide-react';
import { AnalyticsAiView } from './components/AnalyticsAiView';
import { AuthScreen } from './components/AuthScreen';
import { BlindSheetGeneratorView } from './components/BlindSheetGeneratorView';
import { CountPlannerView } from './components/CountPlannerView';
import { CountsWorkspaceView } from './components/CountsWorkspaceView';
import { DashboardView } from './components/DashboardView';
import { LocationsView } from './components/LocationsView';
import { MasterCatalogView } from './components/MasterCatalogView';
import { PosView } from './components/PosView';
import { UsersAuditView } from './components/UsersAuditView';
import { ValidationClosureView } from './components/ValidationClosureView';
import { apiFetch, setAuthToken } from './lib/api';
import { MERCOMAT_LOGO_URL } from './lib/pdfExport';
import { AuthUser, UserRole } from './types/erp';

type NavKey =
  | 'dashboard'
  | 'catalog'
  | 'locations'
  | 'planner'
  | 'counts'
  | 'blind-sheet'
  | 'validation'
  | 'ai'
  | 'pos'
  | 'users';

interface NotificationRow {
  id: number;
  severity: string;
  title: string;
  message: string;
  is_read: number;
  created_at: string;
}

export default function App() {
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [activeTab, setActiveTab] = useState<NavKey>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [notifOpen, setNotifOpen] = useState(false);

  useEffect(() => {
    apiFetch<{ needsBootstrap: boolean }>('/api/auth/status')
      .then((res) => {
        setNeedsBootstrap(res.needsBootstrap);
      })
      .catch(() => {})
      .finally(() => setCheckingAuth(false));
  }, []);

  const loadNotifications = async () => {
    if (!currentUser) return;
    try {
      const res = await apiFetch<{ notifications: NotificationRow[] }>('/api/notifications');
      setNotifications(res.notifications);
    } catch {
      // ignore transient error
    }
  };

  useEffect(() => {
    if (!currentUser) return;
    if (currentUser.role === UserRole.CONTADOR) {
      setActiveTab('counts');
    } else if (currentUser.role === UserRole.RESPONSABLE_DEPOSITO) {
      setActiveTab('counts');
    } else {
      setActiveTab('dashboard');
    }
    loadNotifications();
  }, [currentUser]);

  const handleMarkRead = async (id: number) => {
    await apiFetch(`/api/notifications/${id}/read`, { method: 'POST' });
    await loadNotifications();
  };

  const handleMarkAllRead = async () => {
    await apiFetch('/api/notifications/read-all', { method: 'POST' });
    await loadNotifications();
  };

  const handleLogout = () => {
    setAuthToken(null);
    setCurrentUser(null);
    setNotifications([]);
  };

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-600">
        Inicializando MercoMat Inventarios...
      </div>
    );
  }

  if (!currentUser) {
    return (
      <AuthScreen
        needsBootstrap={needsBootstrap}
        onAuthenticated={(user) => {
          setNeedsBootstrap(false);
          setCurrentUser(user);
        }}
      />
    );
  }

  const navItems: Array<{
    key: NavKey;
    label: string;
    icon: React.ReactNode;
    roles: UserRole[];
  }> = [
    {
      key: 'dashboard',
      label: 'Tablero Gerencial',
      icon: <BarChart3 className="w-4 h-4" />,
      roles: [UserRole.JEFE_STOCK],
    },
    {
      key: 'catalog',
      label: 'Almacén Maestro',
      icon: <Database className="w-4 h-4" />,
      roles: [UserRole.JEFE_STOCK, UserRole.RESPONSABLE_DEPOSITO],
    },
    {
      key: 'locations',
      label: 'Ubicaciones (11)',
      icon: <MapPin className="w-4 h-4" />,
      roles: [UserRole.JEFE_STOCK, UserRole.CONTADOR, UserRole.RESPONSABLE_DEPOSITO],
    },
    {
      key: 'planner',
      label: 'Planificador Inteligente',
      icon: <ListChecks className="w-4 h-4" />,
      roles: [UserRole.JEFE_STOCK],
    },
    {
      key: 'counts',
      label: currentUser.role === UserRole.CONTADOR ? 'Mis Conteos Ciegos' : 'Conteos y Conciliación',
      icon: <ClipboardCheck className="w-4 h-4" />,
      roles: [UserRole.JEFE_STOCK, UserRole.CONTADOR, UserRole.RESPONSABLE_DEPOSITO],
    },
    {
      key: 'blind-sheet',
      label: 'Planilla Conteo Ciego',
      icon: <Printer className="w-4 h-4" />,
      roles: [UserRole.JEFE_STOCK, UserRole.CONTADOR, UserRole.RESPONSABLE_DEPOSITO],
    },
    {
      key: 'validation',
      label: 'Validación y Ajustes',
      icon: <FileCheck2 className="w-4 h-4" />,
      roles: [UserRole.JEFE_STOCK],
    },
    {
      key: 'ai',
      label: 'Inteligencia Analítica',
      icon: <BrainCircuit className="w-4 h-4" />,
      roles: [UserRole.JEFE_STOCK],
    },
    {
      key: 'pos',
      label: 'Punto de Venta (POS)',
      icon: <ShoppingCart className="w-4 h-4" />,
      roles: [UserRole.JEFE_STOCK, UserRole.RESPONSABLE_DEPOSITO],
    },
    {
      key: 'users',
      label: 'Usuarios y Auditoría',
      icon: <Shield className="w-4 h-4" />,
      roles: [UserRole.JEFE_STOCK],
    },
  ];

  const allowedNav = navItems.filter((n) => n.roles.includes(currentUser.role));
  const unreadCount = notifications.filter((n) => !n.is_read).length;
  const activeNavLabel = allowedNav.find((n) => n.key === activeTab)?.label || 'Inicio';

  const roleLabel =
    currentUser.role === UserRole.JEFE_STOCK
      ? 'Jefe de Control de Stock'
      : currentUser.role === UserRole.CONTADOR
        ? 'Responsable de Conteo'
        : 'Responsable de Depósito';

  const sidebarContent = (
    <div className="flex flex-col h-full bg-white border-r border-slate-200 w-64">
      <div className="px-4 py-3.5 bg-[#8e0d0d] border-b-2 border-[#fbc016] flex items-center gap-3">
        <img
          src={MERCOMAT_LOGO_URL}
          alt="Logo MercoMat"
          referrerPolicy="no-referrer"
          className="w-9 h-9 rounded-md object-cover shrink-0 border border-white/20"
        />
        <span className="text-base font-bold tracking-tight text-white whitespace-nowrap">
          Merco<span className="text-[#fbc016]">Mat</span>
        </span>
      </div>

      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {allowedNav.map((item) => {
          const isActive = activeTab === item.key;
          return (
            <button
              key={item.key}
              onClick={() => {
                setActiveTab(item.key);
                setMobileMenuOpen(false);
              }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                isActive
                  ? 'bg-[#8e0d0d] text-white'
                  : 'text-slate-700 hover:bg-red-50/70 hover:text-[#8e0d0d]'
              }`}
            >
              <span className={isActive ? 'text-[#fbc016]' : 'text-slate-500'}>{item.icon}</span>
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="p-4 border-t border-slate-200 space-y-3 bg-slate-50/60">
        <div className="text-xs">
          <div className="font-semibold text-slate-900 truncate">{currentUser.fullName}</div>
          <div className="text-[11px] text-slate-500 truncate">
            {currentUser.username} · {roleLabel}
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
        >
          <LogOut className="w-3.5 h-3.5" />
          Cerrar Sesión
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex print:bg-white">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block shrink-0 no-print">{sidebarContent}</aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex no-print">
          <div className="relative z-10">{sidebarContent}</div>
          <div
            className="flex-1 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
          />
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white border-b border-slate-200 px-4 sm:px-6 h-14 flex items-center justify-between gap-4 sticky top-0 z-30 no-print">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-1.5 text-slate-600 hover:text-[#8e0d0d] rounded-lg hover:bg-slate-100"
              aria-label="Abrir menú"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="text-xs text-slate-500 truncate">
              <span className="font-semibold text-[#8e0d0d]">MercoMat</span>
              <span className="mx-1.5">/</span>
              <span className="font-semibold text-slate-900">{activeNavLabel}</span>
            </div>
          </div>

          <div className="relative flex items-center gap-3 shrink-0">
            <button
              onClick={() => {
                setNotifOpen(!notifOpen);
                loadNotifications();
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:border-[#8e0d0d] hover:text-[#8e0d0d] whitespace-nowrap transition-colors"
            >
              <Bell className="w-3.5 h-3.5" />
              <span>Notificaciones ({unreadCount})</span>
            </button>

            {notifOpen && (
              <div className="absolute right-0 top-11 w-80 sm:w-96 bg-white border border-slate-200 rounded-xl shadow-lg z-40 overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-900">Notificaciones</span>
                  <div className="flex items-center gap-3">
                    {unreadCount > 0 && (
                      <button
                        onClick={handleMarkAllRead}
                        className="text-[11px] text-[#8e0d0d] hover:underline font-medium"
                      >
                        Marcar todas leídas
                      </button>
                    )}
                    <button onClick={() => setNotifOpen(false)} className="text-slate-400 hover:text-slate-700">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <div className="max-h-80 overflow-y-auto divide-y divide-slate-100">
                  {notifications.length === 0 ? (
                    <div className="p-6 text-center text-xs text-slate-500">
                      Sin notificaciones recientes.
                    </div>
                  ) : (
                    notifications.map((n) => (
                      <div
                        key={n.id}
                        className={`p-3 text-xs ${n.is_read ? 'bg-white' : 'bg-amber-50/60'}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-slate-900">{n.title}</span>
                          {!n.is_read && (
                            <button
                              onClick={() => handleMarkRead(n.id)}
                              className="text-[11px] text-[#8e0d0d] hover:underline shrink-0"
                            >
                              Leída
                            </button>
                          )}
                        </div>
                        <p className="text-slate-600 mt-0.5">{n.message}</p>
                        <div className="text-[10px] font-mono text-slate-400 mt-1">
                          {n.created_at}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 max-w-[1440px] w-full mx-auto print:p-0 print:max-w-none">
          {activeTab === 'dashboard' && currentUser.role === UserRole.JEFE_STOCK && (
            <DashboardView currentUser={currentUser} onNavigate={(tab) => setActiveTab(tab)} />
          )}
          {activeTab === 'catalog' && currentUser.role !== UserRole.CONTADOR && (
            <MasterCatalogView currentUser={currentUser} />
          )}
          {activeTab === 'locations' && <LocationsView currentUser={currentUser} />}
          {activeTab === 'planner' && currentUser.role === UserRole.JEFE_STOCK && (
            <CountPlannerView />
          )}
          {activeTab === 'counts' && <CountsWorkspaceView currentUser={currentUser} />}
          {activeTab === 'blind-sheet' && <BlindSheetGeneratorView currentUser={currentUser} />}
          {activeTab === 'validation' && currentUser.role === UserRole.JEFE_STOCK && (
            <ValidationClosureView currentUser={currentUser} />
          )}
          {activeTab === 'ai' && currentUser.role === UserRole.JEFE_STOCK && <AnalyticsAiView />}
          {activeTab === 'pos' && currentUser.role !== UserRole.CONTADOR && (
            <PosView currentUser={currentUser} />
          )}
          {activeTab === 'users' && currentUser.role === UserRole.JEFE_STOCK && (
            <UsersAuditView currentUser={currentUser} />
          )}
        </main>
      </div>
    </div>
  );
}
