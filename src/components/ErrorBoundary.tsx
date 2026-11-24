import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || 'Ocurrió un error inesperado en la aplicación.',
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('MercoMat ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      let displayMessage = this.state.message;
      if (displayMessage.startsWith('{') && displayMessage.includes('"operationType"')) {
        displayMessage =
          'No se pudieron completar los permisos de sincronización en la nube. Verifique su sesión de Google e inténtelo nuevamente.';
      }

      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
          <div className="bg-white border border-red-200 rounded-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-[#8e0d0d] shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h2 className="text-base font-bold text-slate-900">
                  Se produjo una interrupción controlada
                </h2>
                <p className="text-xs text-slate-600 leading-relaxed">{displayMessage}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, message: '' })}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-[#8e0d0d] text-white rounded-lg hover:bg-[#6e0909]"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reintentar
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
