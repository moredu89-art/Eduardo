import * as XLSX from 'xlsx';
import { CriticalityLevel, ExcelColumnMapping } from '../types/erp.ts';
import { db, logAudit } from './db.ts';

const COLUMN_SYNONYMS: Record<keyof ExcelColumnMapping, string[]> = {
  sku: ['codigo', 'código', 'cod', 'sku', 'codigo de articulo', 'código de artículo', 'articulo', 'artículo', 'id_articulo', 'code'],
  description: ['descripcion', 'descripción', 'nombre', 'detalle', 'producto', 'articulo_descripcion', 'description'],
  alias: ['alias', 'codigo_alternativo', 'cod_barra', 'barra', 'referencia', 'sinonimo'],
  family: ['familia', 'rubro', 'categoria', 'categoría', 'linea', 'línea', 'grupo'],
  brand: ['marca', 'fabricante', 'brand'],
  unitOfMeasure: ['unidad', 'um', 'u.m.', 'unidad de medida', 'medida', 'presentacion'],
  erpStock: ['existencia', 'stock', 'stock_fisico', 'existencia_erp', 'cantidad', 'saldo', 'stock erp', 'existencias'],
  location: ['deposito', 'depósito', 'ubicacion', 'ubicación', 'sucursal', 'almacen', 'almacén', 'bodega'],
  costPrice: ['costo', 'precio_costo', 'costo_unitario', 'cost', 'valor_costo'],
  salePrice: ['precio', 'precio_venta', 'precio de venta', 'pvp', 'venta', 'price'],
  committedStock: ['comprometido', 'stock comprometido', 'reservado', 'stock_comprometido', 'pedidos'],
  criticality: ['criticidad', 'prioridad', 'criticality'],
};

function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

export function parseExcelBuffer(buffer: Buffer): {
  headers: string[];
  rows: Record<string, unknown>[];
  suggestedMapping: Partial<ExcelColumnMapping>;
} {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('El archivo Excel no contiene hojas de cálculo.');
  }
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
  if (rows.length === 0) {
    throw new Error('La primera hoja del archivo Excel está vacía.');
  }
  const headers = Object.keys(rows[0]);
  const suggestedMapping: Partial<ExcelColumnMapping> = {};

  for (const field of Object.keys(COLUMN_SYNONYMS) as Array<keyof ExcelColumnMapping>) {
    const synonyms = COLUMN_SYNONYMS[field].map(normalizeHeader);
    const matched = headers.find((header) => {
      const norm = normalizeHeader(header);
      return synonyms.includes(norm) || synonyms.some((syn) => norm.includes(syn));
    });
    if (matched) {
      suggestedMapping[field] = matched;
    }
  }

  return { headers, rows, suggestedMapping };
}

export interface ValidationIssue {
  rowNumber: number;
  sku: string;
  severity: 'ERROR' | 'ADVERTENCIA';
  code: string;
  message: string;
}

export interface ValidationPreviewResult {
  totalRows: number;
  validRowsCount: number;
  globalMasterRowsCount: number;
  newProductsCount: number;
  existingProductsCount: number;
  duplicateSkuLocationPairs: number;
  unmappedLocations: string[];
  issues: ValidationIssue[];
  sampleRows: Array<{
    rowNumber: number;
    sku: string;
    description: string;
    family: string;
    locationName: string;
    matchedLocationId: number | null;
    isGlobalMaster: boolean;
    erpStock: number;
    committedStock: number;
    availableCalculated: number;
    costPrice: number | null;
    salePrice: number | null;
    isNewProduct: boolean;
  }>;
}

function parseNumberField(val: unknown): number | null {
  if (val === '' || val === null || val === undefined) return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  const cleaned = String(val).replace(/\s/g, '').replace(',', '.');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function hasCellValue(val: unknown): boolean {
  return val !== '' && val !== null && val !== undefined && String(val).trim() !== '';
}

function matchLocation(
  rawLocation: string,
  locations: Array<{ id: number; code: string; name: string }>
): { id: number; name: string } | null {
  const norm = normalizeHeader(rawLocation);
  if (!norm) return null;
  const exact = locations.find(
    (l) => normalizeHeader(l.name) === norm || normalizeHeader(l.code) === norm
  );
  if (exact) return exact;
  // Numeric shorthand e.g. "1" -> "Depósito 1"
  if (/^\d+$/.test(norm)) {
    const dep = locations.find((l) => normalizeHeader(l.name) === `deposito ${norm}`);
    if (dep) return dep;
  }
  const partial = locations.find(
    (l) => normalizeHeader(l.name).includes(norm) || norm.includes(normalizeHeader(l.name))
  );
  return partial ?? null;
}

export function validateExcelRows(
  rows: Record<string, unknown>[],
  mapping: ExcelColumnMapping
): ValidationPreviewResult {
  const locations = db
    .prepare('SELECT id, code, name FROM locations WHERE is_active = 1')
    .all() as Array<{ id: number; code: string; name: string }>;

  const existingSkus = new Set(
    (db.prepare('SELECT sku FROM products').all() as Array<{ sku: string }>).map((p) =>
      p.sku.trim().toUpperCase()
    )
  );

  const hasLocationMapping = Boolean(mapping.location && mapping.location.trim());
  const hasStockMapping = Boolean(mapping.erpStock && mapping.erpStock.trim());

  const issues: ValidationIssue[] = [];
  const seenPairs = new Map<string, number>();
  const seenNewSkus = new Set<string>();
  const seenExistingSkus = new Set<string>();
  const unmappedLocationsSet = new Set<string>();
  const sampleRows: ValidationPreviewResult['sampleRows'] = [];
  let duplicatePairs = 0;
  let validRowsCount = 0;
  let globalMasterRowsCount = 0;

  rows.forEach((row, idx) => {
    const rowNumber = idx + 2; // Excel row accounting for header
    const sku = String(row[mapping.sku] ?? '').trim();
    const description = String(row[mapping.description] ?? '').trim();
    const family = mapping.family ? String(row[mapping.family] ?? '').trim() || 'General' : 'General';
    const rawLocation = hasLocationMapping ? String(row[mapping.location!] ?? '').trim() : '';
    const rawStock = hasStockMapping ? row[mapping.erpStock!] : '';
    const stockProvided = hasStockMapping && hasCellValue(rawStock);
    const parsedStock = stockProvided ? parseNumberField(rawStock) : 0;
    const erpStock = parsedStock;
    const committedStock = mapping.committedStock
      ? parseNumberField(row[mapping.committedStock]) ?? 0
      : 0;
    const costPrice = mapping.costPrice ? parseNumberField(row[mapping.costPrice]) : null;
    const salePrice = mapping.salePrice ? parseNumberField(row[mapping.salePrice]) : null;

    let rowHasError = false;

    if (!sku) {
      rowHasError = true;
      issues.push({
        rowNumber,
        sku: '(vacío)',
        severity: 'ERROR',
        code: 'SKU_FALTANTE',
        message: 'Falta el código de artículo (identificador principal).',
      });
    }

    if (!description) {
      rowHasError = true;
      issues.push({
        rowNumber,
        sku: sku || '(vacío)',
        severity: 'ERROR',
        code: 'DESCRIPCION_FALTANTE',
        message: 'Registro incompleto: falta la descripción del artículo.',
      });
    }

    const matchedLoc = rawLocation ? matchLocation(rawLocation, locations) : null;
    if (rawLocation && !matchedLoc) {
      rowHasError = true;
      unmappedLocationsSet.add(rawLocation);
      issues.push({
        rowNumber,
        sku: sku || '(vacío)',
        severity: 'ERROR',
        code: 'UBICACION_INEXISTENTE',
        message: `La ubicación "${rawLocation}" no coincide con ningún depósito o sucursal activo.`,
      });
    }

    if (stockProvided && erpStock === null) {
      rowHasError = true;
      issues.push({
        rowNumber,
        sku: sku || '(vacío)',
        severity: 'ERROR',
        code: 'STOCK_INVALIDO',
        message: `Existencia inválida ("${String(rawStock)}"). Debe ser numérica.`,
      });
    } else if (erpStock !== null && erpStock < 0) {
      issues.push({
        rowNumber,
        sku,
        severity: 'ADVERTENCIA',
        code: 'STOCK_NEGATIVO',
        message: `Existencia negativa (${erpStock}) informada por el ERP.`,
      });
    }

    if (committedStock < 0) {
      issues.push({
        rowNumber,
        sku,
        severity: 'ADVERTENCIA',
        code: 'COMPROMETIDO_NEGATIVO',
        message: `Stock comprometido negativo (${committedStock}). Se normalizará a 0.`,
      });
    } else if (erpStock !== null && committedStock > erpStock) {
      issues.push({
        rowNumber,
        sku,
        severity: 'ADVERTENCIA',
        code: 'INCONSISTENCIA_COMPROMETIDO',
        message: `Inconsistencia: stock comprometido (${committedStock}) supera la existencia ERP (${erpStock}).`,
      });
    }

    if (sku && (!rawLocation || matchedLoc)) {
      const pairKey = matchedLoc
        ? `${sku.toUpperCase()}::${matchedLoc.id}`
        : `${sku.toUpperCase()}::GLOBAL`;

      if (seenPairs.has(pairKey)) {
        duplicatePairs += 1;
        rowHasError = true;
        issues.push({
          rowNumber,
          sku,
          severity: 'ERROR',
          code: matchedLoc ? 'DUPLICADO_SKU_UBICACION' : 'DUPLICADO_SKU_MAESTRO',
          message: matchedLoc
            ? `Código duplicado para "${matchedLoc.name}" (ya apareció en fila ${seenPairs.get(pairKey)}).`
            : `Código duplicado en Almacén Maestro global (ya apareció en fila ${seenPairs.get(pairKey)}).`,
        });
      } else {
        seenPairs.set(pairKey, rowNumber);
      }

      const upperSku = sku.toUpperCase();
      if (existingSkus.has(upperSku)) {
        seenExistingSkus.add(upperSku);
      } else {
        seenNewSkus.add(upperSku);
      }
    }

    if (!rowHasError) {
      validRowsCount += 1;
      if (!matchedLoc) {
        globalMasterRowsCount += 1;
      }
    }

    if (sampleRows.length < 30) {
      const safeStock = erpStock ?? 0;
      const safeCommitted = Math.max(0, committedStock);
      sampleRows.push({
        rowNumber,
        sku,
        description,
        family,
        locationName: matchedLoc
          ? matchedLoc.name
          : rawLocation || 'Almacén Maestro (Global)',
        matchedLocationId: matchedLoc ? matchedLoc.id : null,
        isGlobalMaster: !rawLocation,
        erpStock: safeStock,
        committedStock: safeCommitted,
        availableCalculated: Math.max(0, safeStock - safeCommitted),
        costPrice,
        salePrice,
        isNewProduct: sku ? !existingSkus.has(sku.toUpperCase()) : false,
      });
    }
  });

  return {
    totalRows: rows.length,
    validRowsCount,
    globalMasterRowsCount,
    newProductsCount: seenNewSkus.size,
    existingProductsCount: seenExistingSkus.size,
    duplicateSkuLocationPairs: duplicatePairs,
    unmappedLocations: Array.from(unmappedLocationsSet),
    issues: issues.slice(0, 200),
    sampleRows,
  };
}

export function commitExcelImport(params: {
  filename: string;
  cutoffTimestamp: string;
  rows: Record<string, unknown>[];
  mapping: ExcelColumnMapping;
  userId: number;
  username: string;
  ipAddress: string;
}): {
  batchId: number;
  insertedProducts: number;
  updatedProducts: number;
  updatedBalances: number;
  skippedErrors: number;
  warningsCount: number;
} {
  const locations = db
    .prepare('SELECT id, code, name FROM locations WHERE is_active = 1')
    .all() as Array<{ id: number; code: string; name: string }>;

  const validation = validateExcelRows(params.rows, params.mapping);
  const warningsCount = validation.issues.filter((i) => i.severity === 'ADVERTENCIA').length;

  const hasLocationMapping = Boolean(params.mapping.location && params.mapping.location.trim());
  const hasStockMapping = Boolean(params.mapping.erpStock && params.mapping.erpStock.trim());
  const knownMappedCols = new Set(Object.values(params.mapping).filter(Boolean));

  const insertBatch = db.prepare(`
    INSERT INTO import_batches (
      filename, uploaded_by_user_id, cutoff_timestamp, source_system,
      total_rows, inserted_products, updated_balances, warnings_count,
      column_mapping_json, validation_summary_json
    ) VALUES (?, ?, ?, 'ERP_EXCEL', ?, 0, 0, ?, ?, ?)
  `);

  const selectProd = db.prepare('SELECT id, extra_attributes_json FROM products WHERE sku = ?');
  const insertProd = db.prepare(`
    INSERT INTO products (
      sku, description, alias, family, brand, unit_of_measure,
      cost_price, sale_price, criticality_level, extra_attributes_json, last_erp_sync_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateProd = db.prepare(`
    UPDATE products SET
      description = ?,
      alias = CASE WHEN ? != '' THEN ? ELSE alias END,
      family = CASE WHEN ? != '' THEN ? ELSE family END,
      brand = CASE WHEN ? != '' THEN ? ELSE brand END,
      unit_of_measure = CASE WHEN ? != '' THEN ? ELSE unit_of_measure END,
      cost_price = COALESCE(?, cost_price),
      sale_price = COALESCE(?, sale_price),
      criticality_level = COALESCE(?, criticality_level),
      extra_attributes_json = ?,
      last_erp_sync_at = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `);

  const selectBalance = db.prepare(
    'SELECT id, erp_physical_stock, committed_stock, review_stock, damaged_stock FROM inventory_balances WHERE product_id = ? AND location_id = ?'
  );
  const insertBalance = db.prepare(`
    INSERT INTO inventory_balances (
      product_id, location_id, erp_physical_stock, committed_stock,
      review_stock, damaged_stock, available_stock, last_import_batch_id, last_erp_updated_at
    ) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)
  `);
  const updateBalance = db.prepare(`
    UPDATE inventory_balances SET
      erp_physical_stock = ?,
      committed_stock = ?,
      available_stock = MAX(0, ? - ? - review_stock - damaged_stock - pos_pending_sync),
      last_import_batch_id = ?,
      last_erp_updated_at = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `);

  const insertMovement = db.prepare(`
    INSERT INTO inventory_movements (
      product_id, location_id, movement_type, quantity_delta, stock_bucket,
      reference_type, reference_id, user_id, notes
    ) VALUES (?, ?, 'ERP_IMPORT', ?, 'PHYSICAL', 'IMPORT_BATCH', ?, ?, ?)
  `);

  let insertedProducts = 0;
  let updatedProducts = 0;
  let updatedBalances = 0;
  let skippedErrors = 0;
  const seenPairs = new Set<string>();

  const runImport = db.transaction(() => {
    const batchRes = insertBatch.run(
      params.filename,
      params.userId,
      params.cutoffTimestamp,
      params.rows.length,
      warningsCount,
      JSON.stringify(params.mapping),
      JSON.stringify({
        totalRows: validation.totalRows,
        validRowsCount: validation.validRowsCount,
        globalMasterRowsCount: validation.globalMasterRowsCount,
        newProductsCount: validation.newProductsCount,
        existingProductsCount: validation.existingProductsCount,
        warningsCount,
      })
    );
    const batchId = Number(batchRes.lastInsertRowid);

    for (const row of params.rows) {
      const sku = String(row[params.mapping.sku] ?? '').trim();
      const description = String(row[params.mapping.description] ?? '').trim();
      const rawLocation = hasLocationMapping
        ? String(row[params.mapping.location!] ?? '').trim()
        : '';
      const rawStock = hasStockMapping ? row[params.mapping.erpStock!] : '';
      const stockProvided = hasStockMapping && hasCellValue(rawStock);
      const erpStock = stockProvided ? parseNumberField(rawStock) : 0;
      const matchedLoc = rawLocation ? matchLocation(rawLocation, locations) : null;

      if (!sku || !description || (rawLocation && !matchedLoc) || erpStock === null) {
        skippedErrors += 1;
        continue;
      }

      const pairKey = matchedLoc
        ? `${sku.toUpperCase()}::${matchedLoc.id}`
        : `${sku.toUpperCase()}::GLOBAL`;
      if (seenPairs.has(pairKey)) {
        skippedErrors += 1;
        continue;
      }
      seenPairs.add(pairKey);

      const alias = params.mapping.alias ? String(row[params.mapping.alias] ?? '').trim() : '';
      const family = params.mapping.family ? String(row[params.mapping.family] ?? '').trim() : '';
      const brand = params.mapping.brand ? String(row[params.mapping.brand] ?? '').trim() : '';
      const uom = params.mapping.unitOfMeasure ? String(row[params.mapping.unitOfMeasure] ?? '').trim() : '';
      const costPrice = params.mapping.costPrice ? parseNumberField(row[params.mapping.costPrice]) : null;
      const salePrice = params.mapping.salePrice ? parseNumberField(row[params.mapping.salePrice]) : null;
      const rawCommitted = params.mapping.committedStock
        ? parseNumberField(row[params.mapping.committedStock])
        : null;
      const committedStock = rawCommitted !== null ? Math.max(0, rawCommitted) : null;

      let criticality: CriticalityLevel | null = null;
      if (params.mapping.criticality) {
        const rawCrit = String(row[params.mapping.criticality] ?? '').trim().toUpperCase();
        if (rawCrit.includes('ALT')) criticality = CriticalityLevel.ALTA;
        else if (rawCrit.includes('BAJ')) criticality = CriticalityLevel.BAJA;
        else if (rawCrit.includes('MED')) criticality = CriticalityLevel.MEDIA;
      }

      // Preserve any flexible extra columns from the ERP Excel
      const extraAttrs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (!knownMappedCols.has(k) && v !== '' && v !== null && v !== undefined) {
          extraAttrs[k] = v;
        }
      }

      const productRow = selectProd.get(sku) as { id: number; extra_attributes_json: string } | undefined;
      let productId: number;

      if (!productRow) {
        const res = insertProd.run(
          sku,
          description,
          alias,
          family || 'General',
          brand || 'Sin marca',
          uom || 'UN',
          costPrice,
          salePrice,
          criticality || CriticalityLevel.MEDIA,
          JSON.stringify(extraAttrs),
          params.cutoffTimestamp
        );
        productId = Number(res.lastInsertRowid);
        insertedProducts += 1;
      } else {
        productId = productRow.id;
        let mergedExtra = extraAttrs;
        try {
          mergedExtra = { ...JSON.parse(productRow.extra_attributes_json || '{}'), ...extraAttrs };
        } catch {
          mergedExtra = extraAttrs;
        }
        updateProd.run(
          description,
          alias,
          alias,
          family,
          family,
          brand,
          brand,
          uom,
          uom,
          costPrice,
          salePrice,
          criticality,
          JSON.stringify(mergedExtra),
          params.cutoffTimestamp,
          productId
        );
        updatedProducts += 1;
      }

      // Only create/update per-location inventory_balances when a specific Depósito was provided
      if (matchedLoc) {
        const bal = selectBalance.get(productId, matchedLoc.id) as
          | {
              id: number;
              erp_physical_stock: number;
              committed_stock: number;
              review_stock: number;
              damaged_stock: number;
            }
          | undefined;

        const finalCommitted = committedStock !== null ? committedStock : bal ? bal.committed_stock : 0;

        if (!bal) {
          const available = Math.max(0, erpStock - finalCommitted);
          insertBalance.run(
            productId,
            matchedLoc.id,
            erpStock,
            finalCommitted,
            available,
            batchId,
            params.cutoffTimestamp
          );
          insertMovement.run(
            productId,
            matchedLoc.id,
            erpStock,
            String(batchId),
            params.userId,
            `Alta inicial ERP (${params.filename}) — Corte ${params.cutoffTimestamp}`
          );
        } else {
          const delta = erpStock - bal.erp_physical_stock;
          updateBalance.run(
            erpStock,
            finalCommitted,
            erpStock,
            finalCommitted,
            batchId,
            params.cutoffTimestamp,
            bal.id
          );
          insertMovement.run(
            productId,
            matchedLoc.id,
            delta,
            String(batchId),
            params.userId,
            `Sincronización ERP (${params.filename}): ${bal.erp_physical_stock} -> ${erpStock} — Corte ${params.cutoffTimestamp}`
          );
        }

        updatedBalances += 1;
      }
    }

    db.prepare(
      'UPDATE import_batches SET inserted_products = ?, updated_balances = ? WHERE id = ?'
    ).run(insertedProducts, updatedBalances, batchId);

    logAudit({
      userId: params.userId,
      username: params.username,
      action: 'ERP_EXCEL_IMPORT',
      entityType: 'IMPORT_BATCH',
      entityId: batchId,
      newValue: {
        filename: params.filename,
        cutoffTimestamp: params.cutoffTimestamp,
        insertedProducts,
        updatedProducts,
        updatedBalances,
        skippedErrors,
        warningsCount,
      },
      ipAddress: params.ipAddress,
    });

    return {
      batchId,
      insertedProducts,
      updatedProducts,
      updatedBalances,
      skippedErrors,
      warningsCount,
    };
  });

  return runImport();
}

export function buildExcelTemplateBuffer(): Buffer {
  const wb = XLSX.utils.book_new();
  const sampleHeaders = [
    {
      'Código de artículo': '',
      'Descripción': '',
      'Alias': '',
      'Familia': '',
      'Marca': '',
      'Unidad de medida': 'UN',
      'Depósito': '',
      'Existencia': 0,
      'Stock comprometido': 0,
      'Costo': 0,
      'Precio de venta': 0,
      'Criticidad': 'MEDIA',
    },
  ];
  const ws = XLSX.utils.json_to_sheet(sampleHeaders);
  ws['!cols'] = [
    { wch: 20 },
    { wch: 36 },
    { wch: 16 },
    { wch: 18 },
    { wch: 16 },
    { wch: 16 },
    { wch: 20 },
    { wch: 12 },
    { wch: 18 },
    { wch: 12 },
    { wch: 15 },
    { wch: 14 },
  ];

  const locations = db
    .prepare('SELECT code, name, group_type FROM locations WHERE is_active = 1 ORDER BY id')
    .all() as Array<{ code: string; name: string; group_type: string }>;
  const wsLocs = XLSX.utils.json_to_sheet(
    locations.map((l) => ({
      'Código Ubicación': l.code,
      'Nombre Exacto para Columna Depósito (Opcional)': l.name,
      Grupo: l.group_type,
    }))
  );
  wsLocs['!cols'] = [{ wch: 18 }, { wch: 44 }, { wch: 16 }];

  XLSX.utils.book_append_sheet(wb, ws, 'Plantilla_Almacen_Maestro');
  XLSX.utils.book_append_sheet(wb, wsLocs, 'Ubicaciones_Validas');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}
