import { GoogleGenAI, Type } from '@google/genai';
import { db } from './db.ts';
import { computeRiskMatrix, generatePlanningAlerts } from './riskEngine.ts';

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY no está configurada en el entorno del servidor. Configure la clave en Settings > Secrets para habilitar el análisis ejecutivo con IA.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export interface AiExecutiveReport {
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

export async function generateExecutiveAiAnalysis(locationId?: number): Promise<AiExecutiveReport> {
  const productCount = (db.prepare('SELECT COUNT(*) as c FROM products').get() as { c: number }).c;
  if (productCount === 0) {
    throw new Error(
      'No hay artículos importados en el Almacén Maestro. Importe primero el archivo Excel del ERP para generar análisis con IA basados en datos verificables.'
    );
  }

  const matrix = computeRiskMatrix(locationId);
  const alerts = generatePlanningAlerts();

  const locationStats = db
    .prepare(
      `
      SELECT l.id, l.name, l.group_type,
        COUNT(DISTINCT ib.product_id) as skus,
        COALESCE(SUM(ib.erp_physical_stock), 0) as total_erp_units,
        COALESCE(SUM(ib.committed_stock), 0) as total_committed,
        COALESCE(SUM(CASE WHEN ci.reconciliation_result = 'FALTANTE' THEN 1 ELSE 0 END), 0) as faltantes_cnt,
        COALESCE(SUM(CASE WHEN ci.reconciliation_result = 'SOBRANTE' THEN 1 ELSE 0 END), 0) as sobrantes_cnt,
        COALESCE(SUM(CASE WHEN ci.reconciliation_result = 'COINCIDENCIA' THEN 1 ELSE 0 END), 0) as coincidencias_cnt
      FROM locations l
      LEFT JOIN inventory_balances ib ON ib.location_id = l.id
      LEFT JOIN counts c ON c.location_id = l.id
      LEFT JOIN count_items ci ON ci.count_id = c.id
      ${locationId ? 'WHERE l.id = ?' : ''}
      GROUP BY l.id
      ORDER BY l.id
    `
    )
    .all(...(locationId ? [locationId] : [])) as Array<Record<string, unknown>>;

  const counterStats = db
    .prepare(
      `
      SELECT u.id, u.full_name,
        COUNT(DISTINCT c.id) as total_counts,
        SUM(CASE WHEN c.status IN ('EJECUCION', 'RECHAZADO') THEN 1 ELSE 0 END) as pending_counts,
        SUM(CASE WHEN c.status IN ('ENTREGADO', 'APROBADO') THEN 1 ELSE 0 END) as completed_counts
      FROM users u
      LEFT JOIN counts c ON c.assigned_counter_id = u.id
      WHERE u.role = 'CONTADOR' AND u.is_active = 1
      GROUP BY u.id
    `
    )
    .all() as Array<Record<string, unknown>>;

  const recentDiscrepancies = db
    .prepare(
      `
      SELECT c.count_number, c.created_at, l.name as location_name, p.sku, p.description,
        ci.snapshot_erp_stock, ci.final_counted_qty, ci.difference, ci.reconciliation_result, ci.adjustment_status
      FROM count_items ci
      JOIN counts c ON c.id = ci.count_id
      JOIN locations l ON l.id = c.location_id
      JOIN products p ON p.id = ci.product_id
      WHERE ci.reconciliation_result IN ('FALTANTE', 'SOBRANTE')
      ${locationId ? 'AND c.location_id = ?' : ''}
      ORDER BY c.created_at DESC
      LIMIT 25
    `
    )
    .all(...(locationId ? [locationId] : [])) as Array<Record<string, unknown>>;

  const contextPayload = {
    totalCatalogProducts: productCount,
    topHighRiskItems: matrix.slice(0, 18).map((m) => ({
      sku: m.sku,
      description: m.description,
      location: m.locationName,
      erpStock: m.erpPhysicalStock,
      committedStock: m.committedStock,
      economicValue: m.economicValue,
      movementsCount: m.movementsCount,
      discrepancyCount: m.discrepancyCount,
      daysSinceLastCount: m.daysSinceLastCount,
      riskScore: m.riskScore,
      riskTier: m.riskTier,
    })),
    locationStats,
    counterStats,
    recentDiscrepancies,
    activeAlerts: alerts.slice(0, 15),
  };

  const ai = getAiClient();
  const modelUsed = 'gemini-4-hydrogen';

  const systemInstruction = `Eres el Asistente Analítico de Auditoría Interna y Control de Inventarios para una empresa de materiales para la construcción.
REGLAS ESTRICTAS DE VERACIDAD Y AUDITORÍA:
1. Fundamenta EXCLUSIVAMENTE tus afirmaciones en los datos JSON verificables provistos. No inventes cifras, causas de faltantes ni atribuyas responsabilidades personales sin evidencia directa.
2. Separa rigurosamente:
   - Hechos comprobados (datos objetivos del sistema: cantidades, SKUs, fechas, cobertura).
   - Diferencias detectadas (desvíos medidos en conteos físicos vs ERP).
   - Antecedentes históricos (recurrencia verificada en conteos anteriores).
   - Hipótesis de análisis (líneas de investigación plausibles formuladas como hipótesis, nunca como acusaciones ni hechos).
   - Recomendaciones operativas (prioridad, ubicación, frecuencia y distribución de carga).
3. Recuerda que la decisión final de validación y ajuste siempre corresponde al Jefe de Control de Stock.
4. Responde en español profesional de auditoría y logística.`;

  const response = await ai.models.generateContent({
    model: modelUsed,
    contents: `Analiza los siguientes datos reales del sistema central de inventarios y genera un informe ejecutivo estructurado:\n\n${JSON.stringify(
      contextPayload
    )}`,
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          executiveSummary: { type: Type.STRING },
          hechosComprobados: { type: Type.ARRAY, items: { type: Type.STRING } },
          diferenciasDetectadas: { type: Type.ARRAY, items: { type: Type.STRING } },
          antecedentesHistoricos: { type: Type.ARRAY, items: { type: Type.STRING } },
          hipotesisAnalisis: { type: Type.ARRAY, items: { type: Type.STRING } },
          recomendacionesOperativas: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                prioridad: { type: Type.STRING },
                ubicacion: { type: Type.STRING },
                accion: { type: Type.STRING },
                frecuenciaSugerida: { type: Type.STRING },
                fundamentoVerificable: { type: Type.STRING },
              },
            },
          },
          distribucionSugerida: { type: Type.STRING },
        },
      },
    },
  });

  const parsed = JSON.parse((response.text ?? '{}').trim()) as Partial<AiExecutiveReport>;

  return {
    generatedAt: new Date().toISOString(),
    modelUsed,
    executiveSummary: parsed.executiveSummary || 'Informe generado con los registros verificados.',
    hechosComprobados: Array.isArray(parsed.hechosComprobados) ? parsed.hechosComprobados : [],
    diferenciasDetectadas: Array.isArray(parsed.diferenciasDetectadas)
      ? parsed.diferenciasDetectadas
      : [],
    antecedentesHistoricos: Array.isArray(parsed.antecedentesHistoricos)
      ? parsed.antecedentesHistoricos
      : [],
    hipotesisAnalisis: Array.isArray(parsed.hipotesisAnalisis) ? parsed.hipotesisAnalisis : [],
    recomendacionesOperativas: Array.isArray(parsed.recomendacionesOperativas)
      ? (parsed.recomendacionesOperativas as AiExecutiveReport['recomendacionesOperativas'])
      : [],
    distribucionSugerida:
      parsed.distribucionSugerida || 'Sin contadores activos registrados para redistribución.',
  };
}
