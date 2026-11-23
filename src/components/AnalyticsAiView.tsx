import React, { useEffect, useState } from 'react';
import { BrainCircuit, FileText, RefreshCw } from 'lucide-react';
import { apiFetch } from '../lib/api';

interface AiReport {
  generatedAt: string;
  modelUsed: string;
  executiveSummary: string;
  hechosComprobados: string[];
  diferenciasDetectadas: string[];
  antecedentesHistoricos: string[];
  hipotesisAnalisis: string[];
  recomendacionesOperativas: Array<{
    prioridad: 'CRITICA' | 'ALTA' | 'MEDIA';
    ubicacion: string;
    accion: string;
    frecuenciaSugerida: string;
    fundamentoVerificable: string;
  }>;
  distribucionSugerida: string;
}

export const AnalyticsAiView: React.FC = () => {
  const [locations, setLocations] = useState<Array<{ id: number; name: string }>>([]);
  const [locationId, setLocationId] = useState('');
  const [report, setReport] = useState<AiReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ locations: Array<{ id: number; name: string }> }>('/api/locations')
      .then((res) => setLocations(res.locations))
      .catch(() => {});
  }, []);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ report: AiReport }>('/api/ai/executive-report', {
        method: 'POST',
        body: JSON.stringify({ locationId: locationId ? Number(locationId) : undefined }),
      });
      setReport(res.report);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadTxt = () => {
    if (!report) return;
    const text = [
      `INFORME EJECUTIVO DE AUDITORÍA E INVENTARIOS`,
      `Generado: ${report.generatedAt}`,
      ``,
      `RESUMEN EJECUTIVO`,
      report.executiveSummary,
      ``,
      `1. HECHOS COMPROBADOS`,
      ...report.hechosComprobados.map((h) => `- ${h}`),
      ``,
      `2. DIFERENCIAS DETECTADAS`,
      ...report.diferenciasDetectadas.map((d) => `- ${d}`),
      ``,
      `3. ANTECEDENTES HISTÓRICOS`,
      ...report.antecedentesHistoricos.map((a) => `- ${a}`),
      ``,
      `4. HIPÓTESIS DE ANÁLISIS`,
      ...report.hipotesisAnalisis.map((h) => `- ${h}`),
      ``,
      `5. RECOMENDACIONES OPERATIVAS`,
      ...report.recomendacionesOperativas.map(
        (r) =>
          `[${r.prioridad}] ${r.ubicacion} — ${r.accion} (Frecuencia: ${r.frecuenciaSugerida}). Fundamento: ${r.fundamentoVerificable}`
      ),
      ``,
      `6. DISTRIBUCIÓN SUGERIDA`,
      report.distribucionSugerida,
    ].join('\n');

    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Informe_Ejecutivo_IA_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">
            Inteligencia Analítica y Asistente Ejecutivo
          </h2>
          <p className="text-sm text-slate-600 mt-0.5">
            Análisis predictivo basado exclusivamente en datos verificables del Almacén Maestro, conteos y auditoría. La decisión final corresponde siempre al Jefe de Control de Stock.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className="px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
          >
            <option value="">Consolidado (Todas las ubicaciones)</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <button
            onClick={handleGenerate}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-[#8e0d0d] text-white rounded-lg hover:bg-[#6e0909] disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Analizando registros reales...' : 'Generar Informe Ejecutivo IA'}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800">
          {error}
        </div>
      )}

      {!report ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center max-w-2xl mx-auto space-y-3">
          <BrainCircuit className="w-10 h-10 text-slate-400 mx-auto" />
          <h3 className="text-base font-bold text-slate-900">
            Asistente Analítico de Control de Stock
          </h3>
          <p className="text-xs text-slate-600 leading-relaxed">
            Al ejecutar el análisis, el sistema enviará al motor de IA las métricas reales de riesgo,
            rotación, diferencias históricas y carga por contador para obtener un informe que separa
            estrictamente hechos comprobados, diferencias detectadas, antecedentes, hipótesis y
            recomendaciones accionables.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="text-xs font-mono text-slate-500">
                Generado: {report.generatedAt.slice(0, 19).replace('T', ' ')}
              </div>
              <button
                onClick={handleDownloadTxt}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                <FileText className="w-3.5 h-3.5" />
                Descargar Informe
              </button>
            </div>
            <h3 className="text-base font-bold text-slate-900">Resumen Ejecutivo</h3>
            <p className="text-sm text-slate-700 leading-relaxed">{report.executiveSummary}</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
              <h4 className="text-sm font-bold text-slate-900">1. Hechos Comprobados</h4>
              <ul className="list-disc pl-4 space-y-1.5 text-xs text-slate-700">
                {report.hechosComprobados.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
              <h4 className="text-sm font-bold text-red-800">2. Diferencias Detectadas</h4>
              <ul className="list-disc pl-4 space-y-1.5 text-xs text-slate-700">
                {report.diferenciasDetectadas.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
              <h4 className="text-sm font-bold text-amber-800">3. Antecedentes Históricos</h4>
              <ul className="list-disc pl-4 space-y-1.5 text-xs text-slate-700">
                {report.antecedentesHistoricos.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
              <h4 className="text-sm font-bold text-blue-800">
                4. Hipótesis de Análisis (Sujetas a Verificación)
              </h4>
              <ul className="list-disc pl-4 space-y-1.5 text-xs text-slate-700">
                {report.hipotesisAnalisis.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
            <h4 className="text-sm font-bold text-slate-900">
              5. Recomendaciones Operativas y Frecuencias Sugeridas
            </h4>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="py-2 pr-3">Prioridad</th>
                    <th className="py-2 pr-3">Ubicación</th>
                    <th className="py-2 pr-3">Acción Recomendada</th>
                    <th className="py-2 pr-3">Frecuencia</th>
                    <th className="py-2">Fundamento Verificable</th>
                  </tr>
                </thead>
                <tbody>
                  {report.recomendacionesOperativas.map((rec, i) => (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="py-2 pr-3 font-semibold">{rec.prioridad}</td>
                      <td className="py-2 pr-3">{rec.ubicacion}</td>
                      <td className="py-2 pr-3 font-medium text-slate-900">{rec.accion}</td>
                      <td className="py-2 pr-3 font-mono">{rec.frecuenciaSugerida}</td>
                      <td className="py-2 text-slate-600">{rec.fundamentoVerificable}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="pt-3 border-t border-slate-100 text-xs text-slate-700">
              <strong>Propuesta de Distribución de Carga:</strong> {report.distribucionSugerida}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
