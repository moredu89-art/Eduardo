import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

export const MERCOMAT_LOGO_URL =
  '/assets/aistudio/472159790_1012701800885382_577978362190118729_n_57ff5e27.jpeg';

async function loadLogoBase64(): Promise<string | null> {
  try {
    const res = await fetch(MERCOMAT_LOGO_URL);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export interface BlindSheetPdfData {
  countNumber: string;
  documentUid: string;
  scheduledDate: string;
  scheduledTime?: string;
  locationName: string;
  locationGroup: string;
  familyLabel?: string;
  rubroLabel?: string;
  counterName: string;
  items: Array<{
    sku: string;
    description: string;
    unitOfMeasure: string;
    family?: string;
    rubro?: string;
  }>;
}

export async function exportBlindCountSheetPdf(data: BlindSheetPdfData): Promise<void> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const logoData = await loadLogoBase64();

  // Header brand block with MercoMat logo & corporate colors
  if (logoData) {
    doc.addImage(logoData, 'JPEG', 14, 10, 16, 16);
  } else {
    doc.setFillColor(142, 13, 13);
    doc.rect(14, 10, 16, 16, 'F');
    doc.setTextColor(251, 192, 22);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('M', 19.5, 20.5);
  }

  doc.setTextColor(142, 13, 13);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('MercoMat — Materiales para la Construcción', 34, 16.5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text('PLANILLA DE CONTEO FÍSICO CIEGO (SIN EXISTENCIAS TEÓRICAS)', 34, 22);

  // Subtle crimson + gold brand divider rule
  doc.setDrawColor(142, 13, 13);
  doc.setLineWidth(0.7);
  doc.line(14, 28, 160, 28);
  doc.setDrawColor(251, 192, 22);
  doc.line(160, 28, 196, 28);
  doc.setLineWidth(0.25);

  const timeText =
    data.scheduledTime ||
    new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const familyText = data.familyLabel || 'Todas las familias';
  const rubroText = data.rubroLabel || 'Todos los rubros';

  // Document Metadata Box
  doc.setDrawColor(203, 213, 225);
  doc.rect(14, 31, 182, 31);
  doc.setFontSize(8.5);
  doc.setTextColor(15, 23, 42);

  doc.setFont('helvetica', 'bold');
  doc.text('Nro. Planilla:', 18, 37.5);
  doc.setFont('helvetica', 'normal');
  doc.text(data.countNumber, 43, 37.5);

  doc.setFont('helvetica', 'bold');
  doc.text('ID Documento:', 112, 37.5);
  doc.setFont('helvetica', 'normal');
  doc.text(data.documentUid, 140, 37.5);

  doc.setFont('helvetica', 'bold');
  doc.text('Fecha:', 18, 44);
  doc.setFont('helvetica', 'normal');
  doc.text(data.scheduledDate, 43, 44);

  doc.setFont('helvetica', 'bold');
  doc.text('Hora:', 76, 44);
  doc.setFont('helvetica', 'normal');
  doc.text(timeText, 88, 44);

  doc.setFont('helvetica', 'bold');
  doc.text('Depósito:', 112, 44);
  doc.setFont('helvetica', 'normal');
  doc.text(`${data.locationName} (${data.locationGroup})`.slice(0, 40), 131, 44);

  doc.setFont('helvetica', 'bold');
  doc.text('Familia de Conteo:', 18, 50.5);
  doc.setFont('helvetica', 'normal');
  doc.text(familyText.slice(0, 32), 49, 50.5);

  doc.setFont('helvetica', 'bold');
  doc.text('Rubro:', 112, 50.5);
  doc.setFont('helvetica', 'normal');
  doc.text(rubroText.slice(0, 38), 126, 50.5);

  doc.setFont('helvetica', 'bold');
  doc.text('Responsable Conteo:', 18, 57);
  doc.setFont('helvetica', 'normal');
  doc.text(data.counterName.slice(0, 35), 53, 57);

  doc.setFont('helvetica', 'bold');
  doc.text('Ítems en Planilla:', 112, 57);
  doc.setFont('helvetica', 'normal');
  doc.text(String(data.items.length), 143, 57);

  // Blind Table — strictly NO ERP stock, NO differences
  autoTable(doc, {
    startY: 66,
    head: [
      [
        'Código',
        'Descripción del Artículo',
        'U.M.',
        'Unidades / Bultos',
        'Unidades Sueltas',
        'Observaciones',
      ],
    ],
    body: data.items.map((it) => [it.sku, it.description, it.unitOfMeasure || 'UN', '', '', '']),
    styles: {
      fontSize: 8.2,
      cellPadding: 3.2,
      lineColor: [203, 213, 225],
      lineWidth: 0.25,
      textColor: [15, 23, 42],
      valign: 'middle',
    },
    headStyles: {
      fillColor: [142, 13, 13],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      halign: 'left',
    },
    columnStyles: {
      0: { cellWidth: 24, fontStyle: 'bold' },
      1: { cellWidth: 64 },
      2: { cellWidth: 13, halign: 'center' },
      3: { cellWidth: 26, halign: 'center' },
      4: { cellWidth: 25, halign: 'center' },
      5: { cellWidth: 30 },
    },
    margin: { left: 14, right: 14, bottom: 52 },
  });

  // Ensure sufficient room at bottom of sheet for signatures
  const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || 180;
  let sigY = Math.max(finalY + 14, 240);
  if (finalY > 235) {
    doc.addPage();
    sigY = 235;
  }

  doc.setDrawColor(148, 163, 184);
  doc.setFontSize(8);
  doc.setTextColor(51, 65, 85);

  const boxes = [
    { x: 14, title: '1. Responsable del Conteo', sub: data.counterName || 'Firma y Aclaración' },
    { x: 77, title: '2. Responsable de Depósito', sub: 'Firma y Aclaración' },
    { x: 140, title: '3. Jefe de Control de Stock', sub: 'Recepción y Validación' },
  ];

  for (const box of boxes) {
    doc.rect(box.x, sigY, 56, 30);
    doc.line(box.x + 4, sigY + 19, box.x + 52, sigY + 19);
    doc.setFont('helvetica', 'bold');
    doc.text(box.title, box.x + 3, sigY + 23.5);
    doc.setFont('helvetica', 'normal');
    doc.text(box.sub.slice(0, 28), box.x + 3, sigY + 27.5);
  }

  doc.save(`Planilla_Ciega_MercoMat_${data.countNumber}.pdf`);
}

export interface ExecutiveSummaryPdfData {
  generatedBy: string;
  filtersSummary: {
    dateFrom: string;
    dateTo: string;
    locationName: string;
    counterName: string;
    sku: string;
  };
  quickMetrics: {
    activeInventoryCounts: number;
    enEjecucion: number;
    entregados: number;
    rechazados: number;
    aprobados: number;
    aprobadosPendientesReg: number;
    aprobadosRegularizados: number;
    activeStockUnits: number;
    monthlyApprovedCounts?: number;
  };
  general: {
    totalProducts: number;
    totalLocations: number;
    total_counts: number;
    en_ejecucion: number;
    entregados: number;
    rechazados: number;
    aprobados: number;
    compliancePct: number;
  };
  discrepancies: {
    total_counted_lines: number;
    coincidencias: number;
    faltantes: number;
    sobrantes: number;
    faltantes_units: number;
    sobrantes_units: number;
    abs_economic_diff: number;
    matchRatePct: number | null;
    recountRatePct: number;
  };
  locationReliability: Array<{
    name: string;
    counts_total: number;
    matches: number;
    discrepancies: number;
  }>;
  counterProductivity: Array<{
    full_name: string;
    total_counts: number;
    completed_counts: number;
    total_items_counted: number;
    recount_items: number;
    avg_hours_execution: number | null;
  }>;
  recurringProducts: Array<{
    sku: string;
    description: string;
    location_name: string;
    discrepancy_events: number;
    cumulative_diff: number;
  }>;
  trendSeries: Array<{
    date: string;
    total_lines: number;
    matches: number;
    discrepancies: number;
  }>;
}

export async function exportExecutiveSummaryPdf(data: ExecutiveSummaryPdfData): Promise<void> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const logoData = await loadLogoBase64();

  // Branded Header
  if (logoData) {
    doc.addImage(logoData, 'JPEG', 14, 10, 15, 15);
  } else {
    doc.setFillColor(142, 13, 13);
    doc.rect(14, 10, 15, 15, 'F');
    doc.setTextColor(251, 192, 22);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('M', 19, 19.5);
  }

  doc.setTextColor(142, 13, 13);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('MercoMat — Resumen Ejecutivo de Control de Inventarios', 33, 16);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(71, 85, 105);
  doc.text('REPORTE GERENCIAL DE COBERTURA, CONFIABILIDAD Y DIFERENCIAS DE STOCK', 33, 21.5);

  doc.setDrawColor(142, 13, 13);
  doc.setLineWidth(0.7);
  doc.line(14, 27.5, 160, 27.5);
  doc.setDrawColor(251, 192, 22);
  doc.line(160, 27.5, 196, 27.5);
  doc.setLineWidth(0.25);

  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10);
  const emittedAt = now.toLocaleString('es-AR', { hour12: false });

  // Emission & Filter Metadata
  doc.setDrawColor(203, 213, 225);
  doc.rect(14, 30.5, 182, 20);
  doc.setFontSize(8.2);
  doc.setTextColor(15, 23, 42);

  doc.setFont('helvetica', 'bold');
  doc.text('Fecha de emisión:', 18, 36.5);
  doc.setFont('helvetica', 'normal');
  doc.text(emittedAt, 48, 36.5);

  doc.setFont('helvetica', 'bold');
  doc.text('Generado por:', 110, 36.5);
  doc.setFont('helvetica', 'normal');
  doc.text(data.generatedBy.slice(0, 34), 134, 36.5);

  const f = data.filtersSummary;
  const periodLabel =
    f.dateFrom || f.dateTo
      ? `${f.dateFrom || 'Inicio'} a ${f.dateTo || 'Hoy'}`
      : 'Todo el historial';

  doc.setFont('helvetica', 'bold');
  doc.text('Período:', 18, 42.5);
  doc.setFont('helvetica', 'normal');
  doc.text(periodLabel, 34, 42.5);

  doc.setFont('helvetica', 'bold');
  doc.text('Ubicación:', 110, 42.5);
  doc.setFont('helvetica', 'normal');
  doc.text(f.locationName.slice(0, 36), 129, 42.5);

  doc.setFont('helvetica', 'bold');
  doc.text('Responsable:', 18, 48);
  doc.setFont('helvetica', 'normal');
  doc.text(f.counterName.slice(0, 35), 40, 48);

  doc.setFont('helvetica', 'bold');
  doc.text('Filtro SKU:', 110, 48);
  doc.setFont('helvetica', 'normal');
  doc.text(f.sku || 'Todos', 129, 48);

  const getFinalY = (fallback: number) =>
    (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || fallback;

  // 1. Quick Metrics + Executive KPIs Table
  autoTable(doc, {
    startY: 55,
    head: [['Indicador Clave', 'Valor Actual', 'Detalle / Desglose']],
    body: [
      [
        'Conteos Activos (Ejecución / Rechazado)',
        String(data.quickMetrics.activeInventoryCounts),
        `${data.quickMetrics.enEjecucion} en ejecución · ${data.quickMetrics.rechazados} rechazados · ${data.quickMetrics.activeStockUnits.toLocaleString('es-AR')} u. disp.`,
      ],
      [
        'Conteos Entregados (Pendientes de Revisión)',
        String(data.quickMetrics.entregados),
        `${data.quickMetrics.entregados} esperando revisión · ${data.quickMetrics.aprobadosPendientesReg} aprobado(s) con ajuste ERP pendiente`,
      ],
      [
        'Conteos Aprobados en el Mes',
        String(data.quickMetrics.monthlyApprovedCounts ?? 0),
        `${data.quickMetrics.aprobados} aprobados acumulados · ${data.quickMetrics.aprobadosRegularizados} regularizados en seguimiento ERP`,
      ],
      [
        'Artículos / Ubicaciones Activas',
        `${data.general.totalProducts} / ${data.general.totalLocations}`,
        data.general.totalProducts === 0
          ? 'Pendiente de importación Excel ERP'
          : 'Almacén Maestro centralizado activo',
      ],
      [
        'Cumplimiento del Plan (Aprobados)',
        `${data.general.compliancePct}%`,
        `${data.general.aprobados || 0} aprobados · ${data.general.entregados || 0} entregados · ${data.general.en_ejecucion || 0} en ejecución · ${data.general.rechazados || 0} rechazados`,
      ],
      [
        'Confiabilidad ERP vs Físico',
        data.discrepancies.matchRatePct !== null
          ? `${data.discrepancies.matchRatePct}%`
          : 'Sin conteos',
        `${data.discrepancies.coincidencias || 0} coincidencias de ${data.discrepancies.total_counted_lines || 0} líneas · Reconteo: ${data.discrepancies.recountRatePct}%`,
      ],
      [
        'Impacto Económico de Diferencias',
        `$${Math.abs(data.discrepancies.abs_economic_diff || 0).toLocaleString('es-AR', { maximumFractionDigits: 0 })}`,
        `Faltantes: ${data.discrepancies.faltantes || 0} (${data.discrepancies.faltantes_units || 0} u.) · Sobrantes: ${data.discrepancies.sobrantes || 0} (${data.discrepancies.sobrantes_units || 0} u.)`,
      ],
    ],
    styles: { fontSize: 8, cellPadding: 2.5, lineColor: [203, 213, 225], lineWidth: 0.2 },
    headStyles: { fillColor: [142, 13, 13], textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 52, fontStyle: 'bold' },
      1: { cellWidth: 34, halign: 'right', fontStyle: 'bold' },
      2: { cellWidth: 96 },
    },
    margin: { left: 14, right: 14 },
  });

  // 2. Location Reliability Table
  if (data.locationReliability.length > 0) {
    autoTable(doc, {
      startY: getFinalY(120) + 7,
      head: [['Ubicación / Depósito', 'Conteos', 'Coincidencias', 'Incidencias', 'Confiabilidad']],
      body: data.locationReliability.map((loc) => {
        const total = (loc.matches || 0) + (loc.discrepancies || 0);
        const pct = total > 0 ? `${Math.round((loc.matches / total) * 1000) / 10}%` : '—';
        return [
          loc.name,
          String(loc.counts_total || 0),
          String(loc.matches || 0),
          String(loc.discrepancies || 0),
          pct,
        ];
      }),
      styles: { fontSize: 8, cellPadding: 2.3, lineColor: [203, 213, 225], lineWidth: 0.2 },
      headStyles: { fillColor: [30, 41, 59], textColor: [255, 255, 255], fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: 74, fontStyle: 'bold' },
        1: { cellWidth: 25, halign: 'right' },
        2: { cellWidth: 28, halign: 'right' },
        3: { cellWidth: 27, halign: 'right' },
        4: { cellWidth: 28, halign: 'right', fontStyle: 'bold' },
      },
      margin: { left: 14, right: 14 },
    });
  }

  // 3. Counter Productivity
  if (data.counterProductivity.length > 0) {
    autoTable(doc, {
      startY: getFinalY(160) + 7,
      head: [['Responsable de Conteo', 'Conteos (Comp./Tot.)', 'Ítems Contados', 'Reconteos', 'Prom. Horas']],
      body: data.counterProductivity.map((cp) => [
        cp.full_name,
        `${cp.completed_counts}/${cp.total_counts}`,
        String(cp.total_items_counted || 0),
        String(cp.recount_items || 0),
        cp.avg_hours_execution !== null ? `${cp.avg_hours_execution}h` : '—',
      ]),
      styles: { fontSize: 8, cellPadding: 2.3, lineColor: [203, 213, 225], lineWidth: 0.2 },
      headStyles: { fillColor: [30, 41, 59], textColor: [255, 255, 255], fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: 68, fontStyle: 'bold' },
        1: { cellWidth: 36, halign: 'right' },
        2: { cellWidth: 28, halign: 'right' },
        3: { cellWidth: 24, halign: 'right' },
        4: { cellWidth: 26, halign: 'right' },
      },
      margin: { left: 14, right: 14 },
    });
  }

  // 4. Recurring Discrepancy Products
  if (data.recurringProducts.length > 0) {
    autoTable(doc, {
      startY: getFinalY(190) + 7,
      head: [['Código', 'Artículo', 'Ubicación', 'Eventos', 'Dif. Acumulada']],
      body: data.recurringProducts.map((rp) => [
        rp.sku,
        rp.description,
        rp.location_name,
        String(rp.discrepancy_events),
        rp.cumulative_diff > 0 ? `+${rp.cumulative_diff}` : String(rp.cumulative_diff),
      ]),
      styles: { fontSize: 8, cellPadding: 2.3, lineColor: [203, 213, 225], lineWidth: 0.2 },
      headStyles: { fillColor: [142, 13, 13], textColor: [255, 255, 255], fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: 26, fontStyle: 'bold' },
        1: { cellWidth: 68 },
        2: { cellWidth: 38 },
        3: { cellWidth: 22, halign: 'right' },
        4: { cellWidth: 28, halign: 'right', fontStyle: 'bold' },
      },
      margin: { left: 14, right: 14 },
    });
  }

  // Page numbers in footer
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text(
      `MercoMat — Reporte Ejecutivo de Control de Stock   |   Página ${i} de ${pageCount}`,
      14,
      289
    );
  }

  doc.save(`Resumen_Ejecutivo_MercoMat_${dateStamp}.pdf`);
}

