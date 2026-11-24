import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { LocationGroup, type RiskThresholds, type RiskWeights } from '../types/erp.ts';

const DATA_DIR = process.env.SICEP_DATA_DIR
  ? path.resolve(process.env.SICEP_DATA_DIR)
  : path.resolve(process.cwd(), 'data');
export const DATA_ROOT_DIR = DATA_DIR;
export const UPLOADS_DIR = path.resolve(DATA_DIR, 'uploads');
export const DB_PATH = path.resolve(DATA_DIR, 'erp_inventory.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

export interface StorageDiagnostics {
  dataDir: string;
  dbPath: string;
  uploadsDir: string;
  usesCustomDataDirEnv: boolean;
  mountFilesystemType: string | null;
  mountPoint: string | null;
  isEphemeralOverlay: boolean;
  isVerifiedPersistent: boolean;
}

export function getStorageDiagnostics(): StorageDiagnostics {
  const usesCustomDataDirEnv = Boolean(process.env.SICEP_DATA_DIR && process.env.SICEP_DATA_DIR.trim());
  let mountFilesystemType: string | null = null;
  let mountPoint: string | null = null;

  try {
    if (fs.existsSync('/proc/mounts')) {
      const mounts = fs.readFileSync('/proc/mounts', 'utf8').split('\n');
      let bestMatchLen = -1;
      for (const line of mounts) {
        const parts = line.split(' ');
        if (parts.length < 3) continue;
        const mPoint = parts[1];
        const fsType = parts[2];
        if (
          (DATA_DIR === mPoint || DATA_DIR.startsWith(mPoint === '/' ? '/' : `${mPoint}/`)) &&
          mPoint.length > bestMatchLen
        ) {
          bestMatchLen = mPoint.length;
          mountPoint = mPoint;
          mountFilesystemType = fsType;
        }
      }
    }
  } catch {
    mountFilesystemType = null;
  }

  const isEphemeralOverlay =
    mountFilesystemType === 'overlay' ||
    mountFilesystemType === 'tmpfs' ||
    mountFilesystemType === 'ramfs';

  // Only treat storage as verified persistent if it is NOT on an ephemeral overlay/tmpfs mount
  // and (either a dedicated non-root volume mount exists or a custom external SICEP_DATA_DIR mount is used).
  const isVerifiedPersistent =
    !isEphemeralOverlay &&
    mountFilesystemType !== null &&
    mountPoint !== null &&
    (mountPoint !== '/' || usesCustomDataDirEnv);

  return {
    dataDir: DATA_DIR,
    dbPath: DB_PATH,
    uploadsDir: UPLOADS_DIR,
    usesCustomDataDirEnv,
    mountFilesystemType,
    mountPoint,
    isEphemeralOverlay,
    isVerifiedPersistent,
  };
}

export const DEFAULT_RISK_WEIGHTS: RiskWeights = {
  rotation: 15,
  currentStock: 8,
  committedStock: 10,
  movementCount: 12,
  discrepancyHistory: 16,
  priorCountDiffs: 12,
  economicValue: 10,
  daysSinceLastCount: 7,
  adjustmentFrequency: 5,
  commercialCriticality: 5,
};

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  critical: 75,
  high: 55,
  medium: 32,
};

export function initDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL UNIQUE,
      group_type TEXT NOT NULL CHECK(group_type IN ('CASA_CENTRAL', 'SUCURSAL')),
      address TEXT NOT NULL DEFAULT '',
      manager_user_id INTEGER NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL CHECK(role IN ('JEFE_STOCK', 'CONTADOR', 'RESPONSABLE_DEPOSITO', 'AUDITORIA_DIRECCION')),
      password_hash TEXT NOT NULL,
      assigned_location_ids TEXT NOT NULL DEFAULT '[]',
      assigned_families TEXT NOT NULL DEFAULT '[]',
      token_version INTEGER NOT NULL DEFAULT 1,
      password_changed_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_active INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NULL,
      username TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL DEFAULT '',
      location_id INTEGER NULL,
      old_value_json TEXT NULL,
      new_value_json TEXT NULL,
      ip_address TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      uploaded_by_user_id INTEGER NOT NULL,
      cutoff_timestamp TEXT NOT NULL,
      source_system TEXT NOT NULL DEFAULT 'ERP_EXCEL',
      total_rows INTEGER NOT NULL DEFAULT 0,
      inserted_products INTEGER NOT NULL DEFAULT 0,
      updated_balances INTEGER NOT NULL DEFAULT 0,
      warnings_count INTEGER NOT NULL DEFAULT 0,
      column_mapping_json TEXT NOT NULL,
      validation_summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (uploaded_by_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      alias TEXT NOT NULL DEFAULT '',
      family TEXT NOT NULL DEFAULT 'General',
      brand TEXT NOT NULL DEFAULT 'Sin marca',
      unit_of_measure TEXT NOT NULL DEFAULT 'UN',
      cost_price REAL NULL,
      sale_price REAL NULL,
      criticality_level TEXT NOT NULL DEFAULT 'MEDIA' CHECK(criticality_level IN ('ALTA', 'MEDIA', 'BAJA')),
      extra_attributes_json TEXT NOT NULL DEFAULT '{}',
      last_erp_sync_at TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inventory_balances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      erp_physical_stock REAL NOT NULL DEFAULT 0,
      committed_stock REAL NOT NULL DEFAULT 0,
      review_stock REAL NOT NULL DEFAULT 0,
      damaged_stock REAL NOT NULL DEFAULT 0,
      pos_pending_sync REAL NOT NULL DEFAULT 0,
      available_stock REAL NOT NULL DEFAULT 0,
      last_import_batch_id INTEGER NULL,
      last_erp_updated_at TEXT NULL,
      last_counted_at TEXT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(product_id, location_id),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT,
      FOREIGN KEY (last_import_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      movement_type TEXT NOT NULL CHECK(movement_type IN (
        'ERP_IMPORT', 'POS_SALE', 'POS_RESERVE', 'POS_RESERVE_RELEASE',
        'POS_RETURN', 'POS_VOID', 'ERP_ADJUSTMENT', 'ERP_MOVEMENT'
      )),
      quantity_delta REAL NOT NULL,
      stock_bucket TEXT NOT NULL CHECK(stock_bucket IN ('PHYSICAL', 'COMMITTED', 'REVIEW', 'DAMAGED')),
      reference_type TEXT NOT NULL DEFAULT '',
      reference_id TEXT NOT NULL DEFAULT '',
      erp_operation_number TEXT NOT NULL DEFAULT '',
      user_id INTEGER NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (location_id) REFERENCES locations(id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS risk_config (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      weights_json TEXT NOT NULL,
      thresholds_json TEXT NOT NULL,
      updated_by_user_id INTEGER NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS count_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_type TEXT NOT NULL CHECK(period_type IN ('DIARIA', 'SEMANAL')),
      target_date TEXT NOT NULL,
      location_id INTEGER NULL,
      assigned_counter_id INTEGER NULL,
      target_items_count INTEGER NOT NULL,
      created_by_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL,
      FOREIGN KEY (assigned_counter_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      count_number TEXT NOT NULL UNIQUE,
      document_uid TEXT NOT NULL UNIQUE,
      location_id INTEGER NOT NULL,
      scheduled_date TEXT NOT NULL,
      assigned_counter_id INTEGER NULL,
      warehouse_manager_id INTEGER NULL,
      created_by_user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'BORRADOR' CHECK(status IN (
        'BORRADOR', 'ASIGNADO', 'EN_EJECUCION', 'PENDIENTE_APROBACION',
        'RECHAZADO', 'APROBADO', 'PENDIENTE_REGULARIZACION', 'CERRADO'
      )),
      weekly_goal_tag TEXT NOT NULL DEFAULT '',
      blind_printed_at TEXT NULL,
      executed_at TEXT NULL,
      started_by_user_id INTEGER NULL,
      submitted_at TEXT NULL,
      submitted_by_user_id INTEGER NULL,
      counter_general_notes TEXT NOT NULL DEFAULT '',
      rejected_at TEXT NULL,
      rejected_by_user_id INTEGER NULL,
      rejection_reason TEXT NOT NULL DEFAULT '',
      approved_at TEXT NULL,
      approved_by_user_id INTEGER NULL,
      approval_notes TEXT NOT NULL DEFAULT '',
      validated_at TEXT NULL,
      closed_at TEXT NULL,
      closed_by_user_id INTEGER NULL,
      counter_signature_name TEXT NOT NULL DEFAULT '',
      counter_signed_at TEXT NULL,
      warehouse_signature_name TEXT NOT NULL DEFAULT '',
      warehouse_signed_at TEXT NULL,
      warehouse_confirmed_notes TEXT NOT NULL DEFAULT '',
      chief_signature_name TEXT NOT NULL DEFAULT '',
      chief_signed_at TEXT NULL,
      chief_notes TEXT NOT NULL DEFAULT '',
      has_post_snapshot_movements INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (location_id) REFERENCES locations(id),
      FOREIGN KEY (assigned_counter_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (warehouse_manager_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by_user_id) REFERENCES users(id),
      FOREIGN KEY (started_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (submitted_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (rejected_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (approved_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (closed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS count_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      count_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      snapshot_erp_stock REAL NOT NULL,
      snapshot_committed_stock REAL NOT NULL DEFAULT 0,
      snapshot_cost_price REAL NULL,
      bulk_qty REAL NULL,
      loose_qty REAL NULL,
      counted_qty REAL NULL,
      is_not_counted INTEGER NOT NULL DEFAULT 0,
      not_counted_reason TEXT NOT NULL DEFAULT '',
      recount_bulk_qty REAL NULL,
      recount_loose_qty REAL NULL,
      recount_qty REAL NULL,
      final_counted_qty REAL NULL,
      difference REAL NULL,
      reconciliation_result TEXT NULL CHECK(reconciliation_result IN ('COINCIDENCIA', 'FALTANTE', 'SOBRANTE')),
      counter_observations TEXT NOT NULL DEFAULT '',
      recount_requested_reason TEXT NOT NULL DEFAULT '',
      chief_observations TEXT NOT NULL DEFAULT '',
      historical_alert_text TEXT NOT NULL DEFAULT '',
      adjustment_status TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK(adjustment_status IN ('PENDIENTE', 'AJUSTE', 'MOVIMIENTO', 'SIN_AJUSTE')),
      erp_operation_number TEXT NOT NULL DEFAULT '',
      regularization_date TEXT NULL,
      regularized_by_user_id INTEGER NULL,
      no_adjustment_reason TEXT NOT NULL DEFAULT '',
      adjustment_notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(count_id, product_id),
      FOREIGN KEY (count_id) REFERENCES counts(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (regularized_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS count_state_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      count_id INTEGER NOT NULL,
      previous_status TEXT NULL,
      new_status TEXT NOT NULL,
      changed_by_user_id INTEGER NULL,
      changed_by_username TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (count_id) REFERENCES counts(id) ON DELETE CASCADE,
      FOREIGN KEY (changed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS count_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      count_id INTEGER NOT NULL,
      version_number INTEGER NOT NULL,
      submitted_by_user_id INTEGER NULL,
      submitted_by_username TEXT NOT NULL DEFAULT '',
      counter_signature_name TEXT NOT NULL DEFAULT '',
      warehouse_signature_name TEXT NOT NULL DEFAULT '',
      general_observations TEXT NOT NULL DEFAULT '',
      items_snapshot_json TEXT NOT NULL,
      outcome_status TEXT NOT NULL DEFAULT 'PENDIENTE_APROBACION',
      reviewed_by_user_id INTEGER NULL,
      reviewed_by_username TEXT NOT NULL DEFAULT '',
      review_notes TEXT NOT NULL DEFAULT '',
      reviewed_at TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(count_id, version_number),
      FOREIGN KEY (count_id) REFERENCES counts(id) ON DELETE CASCADE,
      FOREIGN KEY (submitted_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (reviewed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('COUNT_ITEM', 'COUNT_SHEET', 'ADJUSTMENT', 'POS_OPERATION')),
      entity_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      uploaded_by_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (uploaded_by_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS pos_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_number TEXT NOT NULL UNIQUE,
      operation_type TEXT NOT NULL CHECK(operation_type IN ('VENTA', 'RESERVA', 'DEVOLUCION')),
      location_id INTEGER NOT NULL,
      customer_name TEXT NOT NULL DEFAULT 'Consumidor Final',
      customer_doc TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'CONFIRMADA' CHECK(status IN ('PENDIENTE', 'CONFIRMADA', 'ANULADA')),
      subtotal REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      erp_sync_status TEXT NOT NULL DEFAULT 'MODULO_INDEPENDIENTE_LOCAL',
      created_by_user_id INTEGER NOT NULL,
      voided_by_user_id INTEGER NULL,
      void_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (location_id) REFERENCES locations(id),
      FOREIGN KEY (created_by_user_id) REFERENCES users(id),
      FOREIGN KEY (voided_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS pos_operation_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      unit_price REAL NOT NULL,
      line_total REAL NOT NULL,
      FOREIGN KEY (operation_id) REFERENCES pos_operations(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_role TEXT NULL,
      target_user_id INTEGER NULL,
      severity TEXT NOT NULL DEFAULT 'INFO' CHECK(severity IN ('CRITICA', 'ALTA', 'MEDIA', 'INFO')),
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_balances_loc ON inventory_balances(location_id);
    CREATE INDEX IF NOT EXISTS idx_balances_prod ON inventory_balances(product_id);
    CREATE INDEX IF NOT EXISTS idx_movements_prod_loc ON inventory_movements(product_id, location_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_counts_loc_status ON counts(location_id, status);
    CREATE INDEX IF NOT EXISTS idx_count_items_prod ON count_items(product_id);
    CREATE INDEX IF NOT EXISTS idx_count_state_hist_cnt ON count_state_history(count_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_count_sub_cnt ON count_submissions(count_id, version_number DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);
  `);

  // Idempotent migration: upgrade legacy 6-state counts table to 8-state schema & nullable assigned_counter_id
  const countsSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'counts'")
    .get() as { sql?: string } | undefined;

  if (countsSqlRow?.sql && !countsSqlRow.sql.includes("'PENDIENTE_APROBACION'")) {
    const oldCols = (db.prepare('PRAGMA table_info(counts)').all() as Array<{ name: string }>).map(
      (c) => c.name
    );
    const hasCol = (name: string) => oldCols.includes(name);

    db.pragma('foreign_keys = OFF');
    try {
      const migrateTx = db.transaction(() => {
        db.exec(`
          CREATE TABLE counts_migrated (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            count_number TEXT NOT NULL UNIQUE,
            document_uid TEXT NOT NULL UNIQUE,
            location_id INTEGER NOT NULL,
            scheduled_date TEXT NOT NULL,
            assigned_counter_id INTEGER NULL,
            warehouse_manager_id INTEGER NULL,
            created_by_user_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'BORRADOR' CHECK(status IN (
              'BORRADOR', 'ASIGNADO', 'EN_EJECUCION', 'PENDIENTE_APROBACION',
              'RECHAZADO', 'APROBADO', 'PENDIENTE_REGULARIZACION', 'CERRADO'
            )),
            weekly_goal_tag TEXT NOT NULL DEFAULT '',
            blind_printed_at TEXT NULL,
            executed_at TEXT NULL,
            started_by_user_id INTEGER NULL,
            submitted_at TEXT NULL,
            submitted_by_user_id INTEGER NULL,
            counter_general_notes TEXT NOT NULL DEFAULT '',
            rejected_at TEXT NULL,
            rejected_by_user_id INTEGER NULL,
            rejection_reason TEXT NOT NULL DEFAULT '',
            approved_at TEXT NULL,
            approved_by_user_id INTEGER NULL,
            approval_notes TEXT NOT NULL DEFAULT '',
            validated_at TEXT NULL,
            closed_at TEXT NULL,
            closed_by_user_id INTEGER NULL,
            counter_signature_name TEXT NOT NULL DEFAULT '',
            counter_signed_at TEXT NULL,
            warehouse_signature_name TEXT NOT NULL DEFAULT '',
            warehouse_signed_at TEXT NULL,
            warehouse_confirmed_notes TEXT NOT NULL DEFAULT '',
            chief_signature_name TEXT NOT NULL DEFAULT '',
            chief_signed_at TEXT NULL,
            chief_notes TEXT NOT NULL DEFAULT '',
            has_post_snapshot_movements INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (location_id) REFERENCES locations(id),
            FOREIGN KEY (assigned_counter_id) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (warehouse_manager_id) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (created_by_user_id) REFERENCES users(id),
            FOREIGN KEY (started_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (submitted_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (rejected_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (approved_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (closed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
          );

          INSERT INTO counts_migrated (
            id, count_number, document_uid, location_id, scheduled_date,
            assigned_counter_id, warehouse_manager_id, created_by_user_id,
            status, weekly_goal_tag, blind_printed_at, executed_at,
            submitted_at, validated_at, approved_at, closed_at,
            counter_signature_name, counter_signed_at,
            warehouse_signature_name, warehouse_signed_at, warehouse_confirmed_notes,
            chief_signature_name, chief_signed_at, chief_notes,
            has_post_snapshot_movements, created_at, updated_at
          )
          SELECT
            id, count_number, document_uid, location_id, scheduled_date,
            assigned_counter_id, warehouse_manager_id, created_by_user_id,
            CASE status
              WHEN 'PROGRAMADO' THEN 'ASIGNADO'
              WHEN 'EN_PROGRESO' THEN 'EN_EJECUCION'
              WHEN 'ENVIADO_REVISION' THEN 'PENDIENTE_APROBACION'
              WHEN 'RECONTEO_SOLICITADO' THEN 'RECHAZADO'
              WHEN 'VALIDADO' THEN 'PENDIENTE_REGULARIZACION'
              WHEN 'CERRADO' THEN 'CERRADO'
              ELSE 'BORRADOR'
            END,
            weekly_goal_tag,
            blind_printed_at,
            ${hasCol('blind_printed_at') ? 'blind_printed_at' : 'NULL'},
            submitted_at,
            validated_at,
            validated_at,
            closed_at,
            counter_signature_name, counter_signed_at,
            warehouse_signature_name, warehouse_signed_at, warehouse_confirmed_notes,
            chief_signature_name, chief_signed_at, chief_notes,
            has_post_snapshot_movements,
            created_at,
            COALESCE(closed_at, validated_at, submitted_at, blind_printed_at, created_at)
          FROM counts;

          DROP TABLE counts;
          ALTER TABLE counts_migrated RENAME TO counts;
          CREATE INDEX IF NOT EXISTS idx_counts_loc_status ON counts(location_id, status);
        `);
      });
      migrateTx();

      const fkViolations = db.pragma('foreign_key_check');
      if (Array.isArray(fkViolations) && fkViolations.length > 0) {
        throw new Error(`Violación de integridad referencial tras migración: ${JSON.stringify(fkViolations)}`);
      }
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }

  // Idempotent migration for new counts columns
  const currentCountCols = new Set(
    (db.prepare('PRAGMA table_info(counts)').all() as Array<{ name: string }>).map((c) => c.name)
  );
  const missingCountCols: Array<[string, string]> = [
    ['executed_at', 'TEXT NULL'],
    ['started_by_user_id', 'INTEGER NULL'],
    ['submitted_by_user_id', 'INTEGER NULL'],
    ['counter_general_notes', "TEXT NOT NULL DEFAULT ''"],
    ['rejected_at', 'TEXT NULL'],
    ['rejected_by_user_id', 'INTEGER NULL'],
    ['rejection_reason', "TEXT NOT NULL DEFAULT ''"],
    ['approved_at', 'TEXT NULL'],
    ['approved_by_user_id', 'INTEGER NULL'],
    ['approval_notes', "TEXT NOT NULL DEFAULT ''"],
    ['closed_by_user_id', 'INTEGER NULL'],
    ['updated_at', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [colName, colDef] of missingCountCols) {
    if (!currentCountCols.has(colName)) {
      db.exec(`ALTER TABLE counts ADD COLUMN ${colName} ${colDef}`);
    }
  }

  // Backfill initial count_state_history rows for migrated legacy counts if empty
  const existingHistCnt = (db.prepare('SELECT COUNT(*) as cnt FROM count_state_history').get() as { cnt: number }).cnt;
  const existingCountsCnt = (db.prepare('SELECT COUNT(*) as cnt FROM counts').get() as { cnt: number }).cnt;
  if (existingHistCnt === 0 && existingCountsCnt > 0) {
    const legacyCounts = db
      .prepare('SELECT id, status, created_by_user_id, created_at FROM counts')
      .all() as Array<{ id: number; status: string; created_by_user_id: number; created_at: string }>;
    const insertHist = db.prepare(
      `INSERT INTO count_state_history (count_id, previous_status, new_status, changed_by_user_id, changed_by_username, reason, created_at)
       VALUES (?, NULL, ?, ?, 'sistema', 'Estado inicial migrado desde versión previa', ?)`
    );
    for (const lc of legacyCounts) {
      insertHist.run(lc.id, lc.status, lc.created_by_user_id, lc.created_at);
    }
  }

  // Idempotent migration for count_items bulk/loose & not-counted columns
  const countItemCols = db
    .prepare('PRAGMA table_info(count_items)')
    .all() as Array<{ name: string }>;
  const existingColNames = new Set(countItemCols.map((c) => c.name));
  const missingCols: Array<[string, string]> = [
    ['bulk_qty', 'REAL NULL'],
    ['loose_qty', 'REAL NULL'],
    ['is_not_counted', 'INTEGER NOT NULL DEFAULT 0'],
    ['not_counted_reason', "TEXT NOT NULL DEFAULT ''"],
    ['recount_bulk_qty', 'REAL NULL'],
    ['recount_loose_qty', 'REAL NULL'],
  ];
  for (const [colName, colDef] of missingCols) {
    if (!existingColNames.has(colName)) {
      db.exec(`ALTER TABLE count_items ADD COLUMN ${colName} ${colDef}`);
    }
  }

  // Idempotent migration for users columns (assigned_families, token_version, password_changed_at)
  const userCols = db
    .prepare('PRAGMA table_info(users)')
    .all() as Array<{ name: string }>;
  const existingUserCols = new Set(userCols.map((c) => c.name));
  if (!existingUserCols.has('assigned_families')) {
    db.exec("ALTER TABLE users ADD COLUMN assigned_families TEXT NOT NULL DEFAULT '[]'");
  }
  if (!existingUserCols.has('token_version')) {
    db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1');
  }
  if (!existingUserCols.has('password_changed_at')) {
    db.exec("ALTER TABLE users ADD COLUMN password_changed_at TEXT NOT NULL DEFAULT ''");
  }

  // Idempotent migration to add AUDITORIA_DIRECCION to users.role CHECK constraint
  const usersTableMeta = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get() as { sql?: string } | undefined;
  if (usersTableMeta?.sql && !usersTableMeta.sql.includes('AUDITORIA_DIRECCION')) {
    db.pragma('foreign_keys = OFF');
    try {
      const migrateUsersTx = db.transaction(() => {
        db.exec(`
          CREATE TABLE users_migrated (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            full_name TEXT NOT NULL,
            email TEXT NOT NULL DEFAULT '',
            role TEXT NOT NULL CHECK(role IN ('JEFE_STOCK', 'CONTADOR', 'RESPONSABLE_DEPOSITO', 'AUDITORIA_DIRECCION')),
            password_hash TEXT NOT NULL,
            assigned_location_ids TEXT NOT NULL DEFAULT '[]',
            assigned_families TEXT NOT NULL DEFAULT '[]',
            token_version INTEGER NOT NULL DEFAULT 1,
            password_changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            is_active INTEGER NOT NULL DEFAULT 1,
            last_login_at TEXT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          INSERT INTO users_migrated (
            id, username, full_name, email, role, password_hash,
            assigned_location_ids, assigned_families, token_version, password_changed_at,
            is_active, last_login_at, created_at, updated_at
          )
          SELECT
            id, username, full_name, email, role, password_hash,
            assigned_location_ids, assigned_families, token_version, password_changed_at,
            is_active, last_login_at, created_at, updated_at
          FROM users;

          DROP TABLE users;
          ALTER TABLE users_migrated RENAME TO users;
        `);
      });
      migrateUsersTx();

      const fkViolations = db.pragma('foreign_key_check');
      if (Array.isArray(fkViolations) && fkViolations.length > 0) {
        throw new Error(`Violación de integridad referencial tras migración de usuarios: ${JSON.stringify(fkViolations)}`);
      }
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }

  // Seed the 11 physical organizational locations (Section 2) if empty
  const locCount = db.prepare('SELECT COUNT(*) as cnt FROM locations').get() as { cnt: number };
  if (locCount.cnt === 0) {
    const insertLoc = db.prepare(
      'INSERT INTO locations (code, name, group_type, address) VALUES (?, ?, ?, ?)'
    );
    const seedLocations: Array<[string, string, LocationGroup, string]> = [
      ['CC-D1', 'Depósito 1', LocationGroup.CASA_CENTRAL, 'Casa Central — Nave 1'],
      ['CC-D2', 'Depósito 2', LocationGroup.CASA_CENTRAL, 'Casa Central — Nave 2'],
      ['CC-D3', 'Depósito 3', LocationGroup.CASA_CENTRAL, 'Casa Central — Nave 3'],
      ['CC-D4', 'Depósito 4', LocationGroup.CASA_CENTRAL, 'Casa Central — Nave 4'],
      ['CC-D5', 'Depósito 5', LocationGroup.CASA_CENTRAL, 'Casa Central — Nave 5'],
      ['CC-D6', 'Depósito 6', LocationGroup.CASA_CENTRAL, 'Casa Central — Nave 6'],
      ['CC-D7', 'Depósito 7', LocationGroup.CASA_CENTRAL, 'Casa Central — Nave 7'],
      ['SUC-CEN', 'Sucursal Centro', LocationGroup.SUCURSAL, 'Área Comercial Centro'],
      ['SUC-TUC', 'Sucursal Tucumán', LocationGroup.SUCURSAL, 'Sede Tucumán'],
      ['SUC-MIN', 'Sucursal Minorista', LocationGroup.SUCURSAL, 'Salón Minorista'],
      ['SUC-CAT', 'Sucursal Catamarca', LocationGroup.SUCURSAL, 'Sede Catamarca'],
    ];
    const tx = db.transaction(() => {
      for (const loc of seedLocations) {
        insertLoc.run(...loc);
      }
    });
    tx();
  }

  // Ensure default risk_config row exists
  const riskCfg = db.prepare('SELECT id FROM risk_config WHERE id = 1').get();
  if (!riskCfg) {
    db.prepare(
      'INSERT INTO risk_config (id, weights_json, thresholds_json) VALUES (1, ?, ?)'
    ).run(JSON.stringify(DEFAULT_RISK_WEIGHTS), JSON.stringify(DEFAULT_RISK_THRESHOLDS));
  }
}

export function logAudit(params: {
  userId?: number | null;
  username: string;
  action: string;
  entityType: string;
  entityId?: string | number;
  locationId?: number | null;
  oldValue?: unknown;
  newValue?: unknown;
  ipAddress?: string;
}): void {
  db.prepare(`
    INSERT INTO audit_events (
      user_id, username, action, entity_type, entity_id,
      location_id, old_value_json, new_value_json, ip_address
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.userId ?? null,
    params.username,
    params.action,
    params.entityType,
    String(params.entityId ?? ''),
    params.locationId ?? null,
    params.oldValue !== undefined ? JSON.stringify(params.oldValue) : null,
    params.newValue !== undefined ? JSON.stringify(params.newValue) : null,
    params.ipAddress ?? ''
  );
}

export function createNotification(params: {
  targetRole?: string | null;
  targetUserId?: number | null;
  severity: 'CRITICA' | 'ALTA' | 'MEDIA' | 'INFO';
  title: string;
  message: string;
  entityType?: string;
  entityId?: string | number;
}): void {
  db.prepare(`
    INSERT INTO notifications (
      target_role, target_user_id, severity, title, message, entity_type, entity_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.targetRole ?? null,
    params.targetUserId ?? null,
    params.severity,
    params.title,
    params.message,
    params.entityType ?? '',
    String(params.entityId ?? '')
  );
}

export function recomputeAvailableStock(productId: number, locationId: number): void {
  db.prepare(`
    UPDATE inventory_balances
    SET available_stock = MAX(0, erp_physical_stock - committed_stock - review_stock - damaged_stock - pos_pending_sync),
        updated_at = datetime('now')
    WHERE product_id = ? AND location_id = ?
  `).run(productId, locationId);
}
