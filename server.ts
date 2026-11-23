import crypto from 'crypto';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import * as XLSX from 'xlsx';
import { generateExecutiveAiAnalysis } from './src/server/aiService.ts';
import {
  createNotification,
  db,
  initDatabase,
  logAudit,
  recomputeAvailableStock,
  UPLOADS_DIR,
} from './src/server/db.ts';
import {
  buildExcelTemplateBuffer,
  commitExcelImport,
  parseExcelBuffer,
  validateExcelRows,
} from './src/server/excelService.ts';
import {
  buildHistoricalAlertForItem,
  computeRiskMatrix,
  generatePlanningAlerts,
  getRiskConfig,
  suggestBalancedDistribution,
} from './src/server/riskEngine.ts';
import {
  AuthenticatedRequest,
  createSessionToken,
  hashPassword,
  mapDbUser,
  requireAuth,
  requireRole,
  userCanAccessLocation,
  verifyPassword,
} from './src/server/security.ts';
import {
  AdjustmentOperationType,
  CountStatus,
  ExcelColumnMapping,
  LocationGroup,
  PosOperationStatus,
  PosOperationType,
  ReconciliationResult,
  RiskThresholds,
  RiskWeights,
  UserRole,
} from './src/types/erp.ts';

dotenv.config();
initDatabase();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '15mb' }));

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const diskUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10);
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

function getClientIp(req: express.Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function nextSequenceNumber(prefix: string, table: string, column: string): string {
  const year = new Date().getFullYear();
  const row = db
    .prepare(`SELECT COUNT(*) as cnt FROM ${table}`)
    .get() as { cnt: number };
  const seq = String((row?.cnt || 0) + 1).padStart(4, '0');
  return `${prefix}-${year}-${seq}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

// ============================================================================
// 1. AUTHENTICATION & FIRST-RUN BOOTSTRAP
// ============================================================================

app.get('/api/auth/status', (_req, res) => {
  const adminCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'JEFE_STOCK'").get() as {
      cnt: number;
    }
  ).cnt;
  res.json({ needsBootstrap: adminCount === 0 });
});

app.post('/api/auth/bootstrap', (req, res) => {
  const adminCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'JEFE_STOCK'").get() as {
      cnt: number;
    }
  ).cnt;

  if (adminCount > 0) {
    res.status(409).json({
      error: 'El sistema ya fue inicializado. Inicie sesión con sus credenciales.',
    });
    return;
  }

  const { username, fullName, email, password } = req.body as {
    username?: string;
    fullName?: string;
    email?: string;
    password?: string;
  };

  if (!username || !fullName || !password || password.length < 6) {
    res.status(400).json({
      error: 'Debe ingresar usuario, nombre completo y una contraseña de al menos 6 caracteres.',
    });
    return;
  }

  const cleanUser = username.trim().toLowerCase();
  const pwHash = hashPassword(password);

  const info = db
    .prepare(
      `INSERT INTO users (username, full_name, email, role, password_hash, assigned_location_ids, assigned_families, is_active, last_login_at)
       VALUES (?, ?, ?, 'JEFE_STOCK', ?, '[]', '[]', 1, datetime('now'))`
    )
    .run(cleanUser, fullName.trim(), (email || '').trim(), pwHash);

  const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid) as Record<
    string,
    unknown
  >;
  const authUser = mapDbUser(userRow);
  const token = createSessionToken(authUser);

  logAudit({
    userId: authUser.id,
    username: authUser.username,
    action: 'SYSTEM_BOOTSTRAP_ADMIN',
    entityType: 'USER',
    entityId: authUser.id,
    newValue: { username: authUser.username, role: authUser.role },
    ipAddress: getClientIp(req),
  });

  res.status(201).json({ token, user: authUser });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ error: 'Ingrese usuario y contraseña.' });
    return;
  }

  const cleanUser = username.trim().toLowerCase();
  const row = db
    .prepare('SELECT * FROM users WHERE LOWER(username) = ?')
    .get(cleanUser) as Record<string, unknown> | undefined;

  if (!row || !verifyPassword(password, String(row.password_hash))) {
    logAudit({
      username: cleanUser,
      action: 'LOGIN_FAILED',
      entityType: 'AUTH',
      newValue: { username: cleanUser },
      ipAddress: getClientIp(req),
    });
    res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    return;
  }

  if (!row.is_active) {
    res.status(403).json({ error: 'La cuenta se encuentra deshabilitada. Contacte al Jefe de Control de Stock.' });
    return;
  }

  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(row.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id) as Record<
    string,
    unknown
  >;
  const user = mapDbUser(updated);
  const token = createSessionToken(user);

  logAudit({
    userId: user.id,
    username: user.username,
    action: 'USER_LOGIN',
    entityType: 'AUTH',
    entityId: user.id,
    ipAddress: getClientIp(req),
  });

  res.json({ token, user });
});

app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({ user: req.user });
});

// ============================================================================
// 2. USERS, ROLES & PERMISSIONS (Section 5)
// ============================================================================

app.get('/api/users', requireAuth, requireRole(UserRole.JEFE_STOCK), (_req, res) => {
  const rows = db
    .prepare(
      'SELECT id, username, full_name, email, role, assigned_location_ids, assigned_families, is_active, last_login_at, created_at FROM users ORDER BY id ASC'
    )
    .all() as Array<Record<string, unknown>>;
  res.json({ users: rows.map(mapDbUser) });
});

app.post('/api/users', requireAuth, requireRole(UserRole.JEFE_STOCK), (req: AuthenticatedRequest, res) => {
  const { username, fullName, email, role, password, assignedLocationIds, assignedFamilies } = req.body as {
    username?: string;
    fullName?: string;
    email?: string;
    role?: UserRole;
    password?: string;
    assignedLocationIds?: number[];
    assignedFamilies?: string[];
  };

  if (!username || !fullName || !role || !password || password.length < 6) {
    res.status(400).json({
      error: 'Complete usuario, nombre completo, rol y contraseña (mínimo 6 caracteres).',
    });
    return;
  }

  if (!Object.values(UserRole).includes(role)) {
    res.status(400).json({ error: 'Rol inválido.' });
    return;
  }

  const cleanUser = username.trim().toLowerCase();
  const exists = db.prepare('SELECT id FROM users WHERE LOWER(username) = ?').get(cleanUser);
  if (exists) {
    res.status(409).json({ error: `El usuario "${cleanUser}" ya existe.` });
    return;
  }

  const locs = Array.isArray(assignedLocationIds) ? assignedLocationIds.map(Number) : [];
  const fams = Array.isArray(assignedFamilies)
    ? Array.from(new Set(assignedFamilies.map((f) => String(f).trim()).filter(Boolean)))
    : [];
  const pwHash = hashPassword(password);
  const info = db
    .prepare(
      `INSERT INTO users (username, full_name, email, role, password_hash, assigned_location_ids, assigned_families, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(
      cleanUser,
      fullName.trim(),
      (email || '').trim(),
      role,
      pwHash,
      JSON.stringify(locs),
      JSON.stringify(fams)
    );

  const created = mapDbUser(
    db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid) as Record<
      string,
      unknown
    >
  );

  logAudit({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'USER_CREATED',
    entityType: 'USER',
    entityId: created.id,
    newValue: {
      username: created.username,
      role: created.role,
      assignedLocationIds: locs,
      assignedFamilies: fams,
    },
    ipAddress: getClientIp(req),
  });

  res.status(201).json({ user: created });
});

app.patch('/api/users/:id', requireAuth, requireRole(UserRole.JEFE_STOCK), (req: AuthenticatedRequest, res) => {
  const targetId = Number(req.params.id);
  const oldRow = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as
    | Record<string, unknown>
    | undefined;
  if (!oldRow) {
    res.status(404).json({ error: 'Usuario no encontrado.' });
    return;
  }

  const { fullName, email, role, assignedLocationIds, assignedFamilies, isActive } = req.body as {
    fullName?: string;
    email?: string;
    role?: UserRole;
    assignedLocationIds?: number[];
    assignedFamilies?: string[];
    isActive?: boolean;
  };

  if (targetId === req.user!.id && isActive === false) {
    res.status(400).json({ error: 'No puede deshabilitar su propia cuenta de administrador activa.' });
    return;
  }

  const nextRole = role && Object.values(UserRole).includes(role) ? role : (oldRow.role as UserRole);
  const nextLocs = Array.isArray(assignedLocationIds)
    ? JSON.stringify(assignedLocationIds.map(Number))
    : String(oldRow.assigned_location_ids || '[]');
  const nextFams = Array.isArray(assignedFamilies)
    ? JSON.stringify(
        Array.from(new Set(assignedFamilies.map((f) => String(f).trim()).filter(Boolean)))
      )
    : String(oldRow.assigned_families || '[]');
  const nextActive = typeof isActive === 'boolean' ? (isActive ? 1 : 0) : Number(oldRow.is_active);

  db.prepare(
    `UPDATE users SET full_name = ?, email = ?, role = ?, assigned_location_ids = ?, assigned_families = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(
    fullName ? fullName.trim() : String(oldRow.full_name),
    email !== undefined ? email.trim() : String(oldRow.email || ''),
    nextRole,
    nextLocs,
    nextFams,
    nextActive,
    targetId
  );

  const updated = mapDbUser(
    db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as Record<string, unknown>
  );

  logAudit({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'USER_UPDATED',
    entityType: 'USER',
    entityId: targetId,
    oldValue: mapDbUser(oldRow),
    newValue: updated,
    ipAddress: getClientIp(req),
  });

  res.json({ user: updated });
});

app.post(
  '/api/users/:id/reset-password',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK),
  (req: AuthenticatedRequest, res) => {
    const targetId = Number(req.params.id);
    const { newPassword } = req.body as { newPassword?: string };
    if (!newPassword || newPassword.length < 6) {
      res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
      return;
    }

    const oldRow = db.prepare('SELECT id, username FROM users WHERE id = ?').get(targetId) as
      | { id: number; username: string }
      | undefined;
    if (!oldRow) {
      res.status(404).json({ error: 'Usuario no encontrado.' });
      return;
    }

    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(
      hashPassword(newPassword),
      targetId
    );

    logAudit({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'USER_PASSWORD_RESET',
      entityType: 'USER',
      entityId: targetId,
      newValue: { username: oldRow.username, resetBy: req.user!.username },
      ipAddress: getClientIp(req),
    });

    res.json({ ok: true });
  }
);

// ============================================================================
// 3. LOCATIONS (11 ORGANIZATIONAL SITES + DYNAMIC ADDITION)
// ============================================================================

app.get('/api/locations', requireAuth, (req: AuthenticatedRequest, res) => {
  const rows = db
    .prepare(
      `
      SELECT l.*, u.full_name as manager_name,
        (SELECT COUNT(*) FROM inventory_balances ib WHERE ib.location_id = l.id) as skus_count,
        (SELECT COALESCE(SUM(ib.erp_physical_stock), 0) FROM inventory_balances ib WHERE ib.location_id = l.id) as total_erp_stock,
        (SELECT COALESCE(SUM(ib.available_stock), 0) FROM inventory_balances ib WHERE ib.location_id = l.id) as total_available_stock,
        (SELECT COUNT(*) FROM counts c WHERE c.location_id = l.id AND c.status IN ('PROGRAMADO','EN_PROGRESO','ENVIADO_REVISION','RECONTEO_SOLICITADO','VALIDADO')) as open_counts,
        (SELECT COUNT(*) FROM count_items ci JOIN counts c ON c.id = ci.count_id WHERE c.location_id = l.id AND ci.reconciliation_result IN ('FALTANTE','SOBRANTE')) as total_discrepancies,
        (SELECT COUNT(*) FROM count_items ci JOIN counts c ON c.id = ci.count_id WHERE c.location_id = l.id AND ci.reconciliation_result = 'COINCIDENCIA') as total_matches
      FROM locations l
      LEFT JOIN users u ON u.id = l.manager_user_id
      ORDER BY l.id ASC
    `
    )
    .all() as Array<Record<string, unknown>>;

  const filtered =
    req.user!.role === UserRole.JEFE_STOCK
      ? rows
      : rows.filter((r) => userCanAccessLocation(req.user!, Number(r.id)));

  const mapped = filtered.map((r) => {
    const matches = Number(r.total_matches || 0);
    const discs = Number(r.total_discrepancies || 0);
    const reliabilityPct = matches + discs > 0 ? Math.round((matches / (matches + discs)) * 1000) / 10 : null;
    return {
      id: Number(r.id),
      code: String(r.code),
      name: String(r.name),
      groupType: r.group_type as LocationGroup,
      address: String(r.address || ''),
      managerUserId: r.manager_user_id ? Number(r.manager_user_id) : null,
      managerName: r.manager_name ? String(r.manager_name) : null,
      isActive: Boolean(r.is_active),
      createdAt: String(r.created_at),
      skusCount: Number(r.skus_count || 0),
      totalErpStock: Number(r.total_erp_stock || 0),
      totalAvailableStock: Number(r.total_available_stock || 0),
      openCounts: Number(r.open_counts || 0),
      totalDiscrepancies: discs,
      reliabilityPct,
    };
  });

  res.json({ locations: mapped });
});

app.post('/api/locations', requireAuth, requireRole(UserRole.JEFE_STOCK), (req: AuthenticatedRequest, res) => {
  const { code, name, groupType, address, managerUserId } = req.body as {
    code?: string;
    name?: string;
    groupType?: LocationGroup;
    address?: string;
    managerUserId?: number | null;
  };

  if (!code || !name || !groupType || !Object.values(LocationGroup).includes(groupType)) {
    res.status(400).json({ error: 'Código, nombre y grupo (CASA_CENTRAL o SUCURSAL) son obligatorios.' });
    return;
  }

  try {
    const info = db
      .prepare(
        'INSERT INTO locations (code, name, group_type, address, manager_user_id) VALUES (?, ?, ?, ?, ?)'
      )
      .run(code.trim().toUpperCase(), name.trim(), groupType, (address || '').trim(), managerUserId || null);

    logAudit({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'LOCATION_CREATED',
      entityType: 'LOCATION',
      entityId: info.lastInsertRowid as number,
      newValue: { code, name, groupType, address },
      ipAddress: getClientIp(req),
    });

    res.status(201).json({ id: info.lastInsertRowid });
  } catch (err: unknown) {
    res.status(409).json({ error: (err as Error).message || 'Ya existe una ubicación con ese código o nombre.' });
  }
});

app.patch('/api/locations/:id', requireAuth, requireRole(UserRole.JEFE_STOCK), (req: AuthenticatedRequest, res) => {
  const locId = Number(req.params.id);
  const oldRow = db.prepare('SELECT * FROM locations WHERE id = ?').get(locId) as Record<string, unknown> | undefined;
  if (!oldRow) {
    res.status(404).json({ error: 'Ubicación no encontrada.' });
    return;
  }

  const { name, address, managerUserId, isActive } = req.body as {
    name?: string;
    address?: string;
    managerUserId?: number | null;
    isActive?: boolean;
  };

  db.prepare(
    'UPDATE locations SET name = ?, address = ?, manager_user_id = ?, is_active = ? WHERE id = ?'
  ).run(
    name ? name.trim() : String(oldRow.name),
    address !== undefined ? address.trim() : String(oldRow.address || ''),
    managerUserId !== undefined ? managerUserId : oldRow.manager_user_id,
    typeof isActive === 'boolean' ? (isActive ? 1 : 0) : Number(oldRow.is_active),
    locId
  );

  logAudit({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'LOCATION_UPDATED',
    entityType: 'LOCATION',
    entityId: locId,
    oldValue: oldRow,
    newValue: req.body,
    ipAddress: getClientIp(req),
  });

  res.json({ ok: true });
});

app.get('/api/locations/:id/detail', requireAuth, (req: AuthenticatedRequest, res) => {
  const locId = Number(req.params.id);
  if (!userCanAccessLocation(req.user!, locId)) {
    res.status(403).json({ error: 'No tiene permisos asignados para consultar esta ubicación.' });
    return;
  }

  const location = db
    .prepare(
      `SELECT l.*, u.full_name as manager_name
       FROM locations l LEFT JOIN users u ON u.id = l.manager_user_id
       WHERE l.id = ?`
    )
    .get(locId) as Record<string, unknown> | undefined;

  if (!location) {
    res.status(404).json({ error: 'Ubicación no encontrada.' });
    return;
  }

  // Strictly block raw ERP balances for CONTADOR role
  const inventory =
    req.user!.role === UserRole.CONTADOR
      ? []
      : db
          .prepare(
            `SELECT p.id as product_id, p.sku, p.description, p.family, p.brand, p.unit_of_measure,
              p.cost_price, p.sale_price, ib.erp_physical_stock, ib.committed_stock,
              ib.review_stock, ib.damaged_stock, ib.pos_pending_sync, ib.available_stock,
              ib.last_erp_updated_at, ib.last_counted_at
             FROM inventory_balances ib
             JOIN products p ON p.id = ib.product_id
             WHERE ib.location_id = ?
             ORDER BY p.description ASC`
          )
          .all(locId);

  const countHistory = db
    .prepare(
      `SELECT c.*, u.full_name as counter_name
       FROM counts c
       JOIN users u ON u.id = c.assigned_counter_id
       WHERE c.location_id = ?
       ${req.user!.role === UserRole.CONTADOR ? 'AND c.assigned_counter_id = ?' : ''}
       ORDER BY c.created_at DESC LIMIT 50`
    )
    .all(...(req.user!.role === UserRole.CONTADOR ? [locId, req.user!.id] : [locId]));

  const discrepancyHistory =
    req.user!.role === UserRole.CONTADOR
      ? []
      : db
          .prepare(
            `SELECT c.count_number, c.created_at, p.sku, p.description,
              ci.snapshot_erp_stock, ci.final_counted_qty, ci.difference,
              ci.reconciliation_result, ci.adjustment_status, ci.erp_operation_number
             FROM count_items ci
             JOIN counts c ON c.id = ci.count_id
             JOIN products p ON p.id = ci.product_id
             WHERE c.location_id = ? AND ci.reconciliation_result IN ('FALTANTE', 'SOBRANTE')
             ORDER BY c.created_at DESC LIMIT 50`
          )
          .all(locId);

  const movementHistory =
    req.user!.role === UserRole.CONTADOR
      ? []
      : db
          .prepare(
            `SELECT im.*, p.sku, p.description, u.username
             FROM inventory_movements im
             JOIN products p ON p.id = im.product_id
             LEFT JOIN users u ON u.id = im.user_id
             WHERE im.location_id = ?
             ORDER BY im.created_at DESC LIMIT 80`
          )
          .all(locId);

  res.json({
    location,
    inventory,
    countHistory,
    discrepancyHistory,
    movementHistory,
  });
});

// ============================================================================
// 4. MASTER WAREHOUSE (ALMACÉN MAESTRO) & EXCEL IMPORT/EXPORT (Section 3)
// ============================================================================

app.get('/api/inventory/template', requireAuth, (_req, res) => {
  const buffer = buildExcelTemplateBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="Plantilla_Almacen_Maestro_ERP.xlsx"');
  res.send(buffer);
});

app.get('/api/products/families', requireAuth, (_req, res) => {
  const rows = db
    .prepare(
      "SELECT DISTINCT TRIM(family) as family FROM products WHERE TRIM(family) != '' ORDER BY family ASC"
    )
    .all() as Array<{ family: string }>;
  res.json({ families: rows.map((r) => r.family) });
});

app.get('/api/inventory', requireAuth, (req: AuthenticatedRequest, res) => {
  if (req.user!.role === UserRole.CONTADOR) {
    res.status(403).json({
      error: 'Acceso restringido: los responsables de conteo no pueden consultar existencias teóricas del ERP para preservar el conteo ciego.',
    });
    return;
  }

  const search = String(req.query.search || '').trim();
  const locationId = req.query.locationId ? Number(req.query.locationId) : null;
  const family = String(req.query.family || '').trim();

  if (locationId && !userCanAccessLocation(req.user!, locationId)) {
    res.status(403).json({ error: 'No tiene acceso a esta ubicación.' });
    return;
  }

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (req.user!.role !== UserRole.JEFE_STOCK) {
    if (req.user!.assignedLocationIds.length === 0) {
      res.json({ items: [], consolidated: [], batchesCount: 0 });
      return;
    }
    const placeholders = req.user!.assignedLocationIds.map(() => '?').join(',');
    conditions.push(`ib.location_id IN (${placeholders})`);
    params.push(...req.user!.assignedLocationIds);
  }

  if (locationId) {
    conditions.push('ib.location_id = ?');
    params.push(locationId);
  }
  if (family) {
    conditions.push('p.family = ?');
    params.push(family);
  }
  if (search) {
    conditions.push('(p.sku LIKE ? OR p.description LIKE ? OR p.alias LIKE ? OR p.brand LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const items = db
    .prepare(
      `SELECT
        ib.id as balance_id,
        p.id as product_id,
        p.sku,
        p.description,
        p.alias,
        p.family,
        p.brand,
        p.unit_of_measure,
        p.cost_price,
        p.sale_price,
        p.criticality_level,
        p.last_erp_sync_at,
        ib.location_id,
        l.name as location_name,
        l.code as location_code,
        ib.erp_physical_stock,
        ib.committed_stock,
        ib.review_stock,
        ib.damaged_stock,
        ib.pos_pending_sync,
        ib.available_stock,
        ib.last_erp_updated_at,
        ib.last_counted_at
      FROM inventory_balances ib
      JOIN products p ON p.id = ib.product_id
      JOIN locations l ON l.id = ib.location_id
      ${whereSql}
      ORDER BY p.description ASC, l.id ASC
      LIMIT 1500`
    )
    .all(...params);

  const consolidatedConds: string[] = [];
  const consolidatedParams: unknown[] = [];
  if (family) {
    consolidatedConds.push('p.family = ?');
    consolidatedParams.push(family);
  }
  if (search) {
    consolidatedConds.push('(p.sku LIKE ? OR p.description LIKE ? OR p.alias LIKE ? OR p.brand LIKE ?)');
    const like = `%${search}%`;
    consolidatedParams.push(like, like, like, like);
  }
  const consolidatedWhereSql =
    consolidatedConds.length > 0 ? `WHERE ${consolidatedConds.join(' AND ')}` : '';

  const consolidated = db
    .prepare(
      `SELECT
        p.id as product_id,
        p.sku,
        p.description,
        p.alias,
        p.family,
        p.brand,
        p.unit_of_measure,
        p.cost_price,
        p.sale_price,
        p.criticality_level,
        p.last_erp_sync_at,
        COUNT(DISTINCT ib.location_id) as locations_count,
        COALESCE(SUM(ib.erp_physical_stock), 0) as total_erp_physical,
        COALESCE(SUM(ib.committed_stock), 0) as total_committed,
        COALESCE(SUM(ib.review_stock), 0) as total_review,
        COALESCE(SUM(ib.damaged_stock), 0) as total_damaged,
        COALESCE(SUM(ib.pos_pending_sync), 0) as total_pos_pending,
        COALESCE(SUM(ib.available_stock), 0) as total_available
      FROM products p
      LEFT JOIN inventory_balances ib ON ib.product_id = p.id
      ${consolidatedWhereSql}
      GROUP BY p.id
      ORDER BY p.description ASC
      LIMIT 1500`
    )
    .all(...consolidatedParams);

  const batchesCount = (
    db.prepare('SELECT COUNT(*) as cnt FROM import_batches').get() as { cnt: number }
  ).cnt;

  const families = (
    db
      .prepare(
        "SELECT DISTINCT TRIM(family) as family FROM products WHERE TRIM(family) != '' ORDER BY family ASC"
      )
      .all() as Array<{ family: string }>
  ).map((r) => r.family);

  res.json({ items, consolidated, batchesCount, families });
});

app.get('/api/inventory/batches', requireAuth, requireRole(UserRole.JEFE_STOCK), (_req, res) => {
  const batches = db
    .prepare(
      `SELECT ib.*, u.full_name as uploaded_by_name
       FROM import_batches ib
       JOIN users u ON u.id = ib.uploaded_by_user_id
       ORDER BY ib.created_at DESC LIMIT 50`
    )
    .all();
  res.json({ batches });
});

app.post(
  '/api/inventory/import/preview',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK),
  memoryUpload.single('file'),
  (req: AuthenticatedRequest, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'Seleccione un archivo Excel (.xlsx o .xls).' });
      return;
    }

    try {
      const parsed = parseExcelBuffer(req.file.buffer);
      res.json({
        filename: req.file.originalname,
        headers: parsed.headers,
        totalRows: parsed.rows.length,
        suggestedMapping: parsed.suggestedMapping,
        rows: parsed.rows,
      });
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message || 'No se pudo leer el archivo Excel.' });
    }
  }
);

app.post(
  '/api/inventory/import/validate',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK),
  (req: AuthenticatedRequest, res) => {
    const { rows, mapping } = req.body as {
      rows?: Record<string, unknown>[];
      mapping?: ExcelColumnMapping;
    };

    if (!Array.isArray(rows) || !mapping?.sku || !mapping?.description) {
      res.status(400).json({
        error: 'Debe relacionar al menos las columnas obligatorias: Código de artículo y Descripción.',
      });
      return;
    }

    const preview = validateExcelRows(rows, mapping);
    res.json({ preview });
  }
);

app.post(
  '/api/inventory/import/commit',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK),
  (req: AuthenticatedRequest, res) => {
    const { filename, cutoffTimestamp, rows, mapping } = req.body as {
      filename?: string;
      cutoffTimestamp?: string;
      rows?: Record<string, unknown>[];
      mapping?: ExcelColumnMapping;
    };

    if (!Array.isArray(rows) || !mapping?.sku || !mapping?.description) {
      res.status(400).json({ error: 'Datos de importación incompletos (Código y Descripción requeridos).' });
      return;
    }

    const result = commitExcelImport({
      filename: filename || 'importacion_erp.xlsx',
      cutoffTimestamp: cutoffTimestamp || new Date().toISOString(),
      rows,
      mapping,
      userId: req.user!.id,
      username: req.user!.username,
      ipAddress: getClientIp(req),
    });

    res.status(201).json(result);
  }
);

app.patch(
  '/api/inventory/balance-buckets',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK),
  (req: AuthenticatedRequest, res) => {
    const { productId, locationId, reviewStock, damagedStock, reason } = req.body as {
      productId?: number;
      locationId?: number;
      reviewStock?: number;
      damagedStock?: number;
      reason?: string;
    };

    if (!productId || !locationId) {
      res.status(400).json({ error: 'Artículo y ubicación requeridos.' });
      return;
    }

    const bal = db
      .prepare('SELECT * FROM inventory_balances WHERE product_id = ? AND location_id = ?')
      .get(productId, locationId) as Record<string, unknown> | undefined;

    if (!bal) {
      res.status(404).json({ error: 'Registro de existencia no encontrado.' });
      return;
    }

    const nextReview = Math.max(0, Number(reviewStock ?? bal.review_stock));
    const nextDamaged = Math.max(0, Number(damagedStock ?? bal.damaged_stock));

    db.prepare('UPDATE inventory_balances SET review_stock = ?, damaged_stock = ? WHERE id = ?').run(
      nextReview,
      nextDamaged,
      bal.id
    );
    recomputeAvailableStock(productId, locationId);

    logAudit({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'STOCK_BUCKETS_UPDATED',
      entityType: 'INVENTORY_BALANCE',
      entityId: bal.id as number,
      locationId,
      oldValue: { reviewStock: bal.review_stock, damagedStock: bal.damaged_stock },
      newValue: { reviewStock: nextReview, damagedStock: nextDamaged, reason: reason || '' },
      ipAddress: getClientIp(req),
    });

    res.json({ ok: true });
  }
);

app.get('/api/inventory/export', requireAuth, requireRole(UserRole.JEFE_STOCK), (_req, res) => {
  const rows = db
    .prepare(
      `SELECT p.sku as "Código", p.description as "Descripción", p.alias as "Alias",
        p.family as "Familia", p.brand as "Marca", p.unit_of_measure as "UM",
        COALESCE(l.name, 'Almacén Maestro (Global)') as "Ubicación",
        COALESCE(ib.erp_physical_stock, 0) as "Existencia ERP",
        COALESCE(ib.committed_stock, 0) as "Comprometido",
        COALESCE(ib.review_stock, 0) as "En Revisión",
        COALESCE(ib.damaged_stock, 0) as "Rotura",
        COALESCE(ib.pos_pending_sync, 0) as "POS Local Sin Sync",
        COALESCE(ib.available_stock, 0) as "Disponible",
        p.cost_price as "Costo", p.sale_price as "Precio Venta",
        COALESCE(ib.last_erp_updated_at, p.last_erp_sync_at) as "Última Actualización ERP"
       FROM products p
       LEFT JOIN inventory_balances ib ON ib.product_id = p.id
       LEFT JOIN locations l ON l.id = ib.location_id
       ORDER BY COALESCE(l.id, 0), p.description`
    )
    .all();

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Almacen_Maestro');
  const buf = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="Almacen_Maestro_Consolidado.xlsx"');
  res.send(buf);
});

// ============================================================================
// 5. RISK SCORING & INTELLIGENT COUNT PLANNING (Section 4)
// ============================================================================

app.get('/api/risk/config', requireAuth, requireRole(UserRole.JEFE_STOCK), (_req, res) => {
  res.json(getRiskConfig());
});

app.put('/api/risk/config', requireAuth, requireRole(UserRole.JEFE_STOCK), (req: AuthenticatedRequest, res) => {
  const { weights, thresholds } = req.body as {
    weights?: RiskWeights;
    thresholds?: RiskThresholds;
  };
  if (!weights || !thresholds) {
    res.status(400).json({ error: 'Pesos y umbrales de riesgo requeridos.' });
    return;
  }

  const prev = getRiskConfig();
  db.prepare(
    "UPDATE risk_config SET weights_json = ?, thresholds_json = ?, updated_by_user_id = ?, updated_at = datetime('now') WHERE id = 1"
  ).run(JSON.stringify(weights), JSON.stringify(thresholds), req.user!.id);

  logAudit({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'RISK_CONFIG_UPDATED',
    entityType: 'RISK_CONFIG',
    entityId: 1,
    oldValue: prev,
    newValue: { weights, thresholds },
    ipAddress: getClientIp(req),
  });

  res.json({ ok: true });
});

app.get('/api/risk/matrix', requireAuth, requireRole(UserRole.JEFE_STOCK), (req, res) => {
  const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;
  const family = req.query.family ? String(req.query.family).trim() : undefined;
  const matrix = computeRiskMatrix(locationId, family || undefined);
  const alerts = generatePlanningAlerts();
  res.json({ matrix, alerts });
});

app.post('/api/risk/distribute', requireAuth, requireRole(UserRole.JEFE_STOCK), (req, res) => {
  const { locationId, maxItems, family, counterIds } = req.body as {
    locationId?: number;
    maxItems?: number;
    family?: string;
    counterIds?: number[];
  };
  if (!locationId) {
    res.status(400).json({ error: 'Seleccione una ubicación.' });
    return;
  }
  const plan = suggestBalancedDistribution({
    locationId: Number(locationId),
    maxItems: Number(maxItems || 15),
    family: family ? String(family).trim() : undefined,
    counterIds,
  });
  res.json(plan);
});

app.get('/api/goals', requireAuth, (_req, res) => {
  const goals = db
    .prepare(
      `SELECT g.*, l.name as location_name, u.full_name as counter_name
       FROM count_goals g
       LEFT JOIN locations l ON l.id = g.location_id
       LEFT JOIN users u ON u.id = g.assigned_counter_id
       ORDER BY g.target_date DESC, g.id DESC LIMIT 40`
    )
    .all();
  res.json({ goals });
});

app.post('/api/goals', requireAuth, requireRole(UserRole.JEFE_STOCK), (req: AuthenticatedRequest, res) => {
  const { periodType, targetDate, locationId, assignedCounterId, targetItemsCount } = req.body as {
    periodType?: 'DIARIA' | 'SEMANAL';
    targetDate?: string;
    locationId?: number | null;
    assignedCounterId?: number | null;
    targetItemsCount?: number;
  };

  if (!periodType || !targetDate || !targetItemsCount) {
    res.status(400).json({ error: 'Tipo de meta, fecha y cantidad objetivo son requeridos.' });
    return;
  }

  const info = db
    .prepare(
      `INSERT INTO count_goals (period_type, target_date, location_id, assigned_counter_id, target_items_count, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      periodType,
      targetDate,
      locationId || null,
      assignedCounterId || null,
      Number(targetItemsCount),
      req.user!.id
    );

  res.status(201).json({ id: info.lastInsertRowid });
});

// ============================================================================
// 6. BLIND COUNTS, SHEETS, RECONCILIATION, VALIDATION & CLOSURE (Sections 6-9)
// ============================================================================

app.get('/api/blind-sheet/catalog', requireAuth, (req: AuthenticatedRequest, res) => {
  const locationId = req.query.locationId ? Number(req.query.locationId) : null;
  const family = String(req.query.family || '').trim();
  const rubro = String(req.query.rubro || '').trim();
  const search = String(req.query.search || '').trim();

  if (locationId && req.user!.role !== UserRole.JEFE_STOCK) {
    const hasCountInLoc = db
      .prepare('SELECT 1 FROM counts WHERE location_id = ? AND assigned_counter_id = ? LIMIT 1')
      .get(locationId, req.user!.id);
    if (!userCanAccessLocation(req.user!, locationId) && !hasCountInLoc) {
      res.status(403).json({ error: 'No tiene permisos para generar planillas en esta ubicación.' });
      return;
    }
  }

  const conds: string[] = [];
  const params: unknown[] = [];

  if (req.user!.role !== UserRole.JEFE_STOCK && req.user!.assignedLocationIds.length === 0 && !locationId) {
    res.json({ items: [], families: [], rubros: [] });
    return;
  }

  // Filter by counter's assigned counting families when configured
  if (req.user!.role === UserRole.CONTADOR && req.user!.assignedFamilies.length > 0) {
    const famPlaceholders = req.user!.assignedFamilies.map(() => 'LOWER(?)').join(',');
    conds.push(`LOWER(TRIM(p.family)) IN (${famPlaceholders})`);
    params.push(...req.user!.assignedFamilies);
  }

  if (family) {
    conds.push('p.family = ?');
    params.push(family);
  }
  if (search) {
    conds.push('(p.sku LIKE ? OR p.description LIKE ? OR p.alias LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  const whereSql = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const selectedLoc = locationId
    ? (db
        .prepare('SELECT id, name, group_type FROM locations WHERE id = ?')
        .get(locationId) as { id: number; name: string; group_type: string } | undefined)
    : undefined;

  // Query all Almacén Maestro products so globally imported catalogs work immediately in any authorized deposit
  const rawRows = db
    .prepare(
      `SELECT
        p.id as product_id,
        p.sku,
        p.description,
        p.alias,
        p.family,
        p.brand,
        p.unit_of_measure,
        p.extra_attributes_json
       FROM products p
       ${whereSql}
       ORDER BY p.family ASC, p.description ASC
       LIMIT 1500`
    )
    .all(...params) as Array<Record<string, unknown>>;

  const mapped = rawRows.map((r) => {
    let extraRubro = '';
    try {
      const parsed = JSON.parse(String(r.extra_attributes_json || '{}')) as Record<string, unknown>;
      extraRubro = String(
        parsed.rubro ?? parsed.Rubro ?? parsed.RUBRO ?? parsed.subfamilia ?? parsed.Subfamilia ?? ''
      ).trim();
    } catch {
      extraRubro = '';
    }
    const resolvedRubro = extraRubro || String(r.brand || 'General');
    return {
      product_id: Number(r.product_id),
      sku: String(r.sku),
      description: String(r.description),
      alias: String(r.alias || ''),
      family: String(r.family || 'General'),
      brand: String(r.brand || 'Sin marca'),
      rubro: resolvedRubro,
      unit_of_measure: String(r.unit_of_measure || 'UN'),
      location_id: selectedLoc ? selectedLoc.id : 0,
      location_name: selectedLoc ? selectedLoc.name : 'Almacén Maestro',
      location_group: selectedLoc ? selectedLoc.group_type : 'CONSOLIDADO',
    };
  });

  const families = Array.from(new Set(mapped.map((m) => m.family))).sort();
  const rubros = Array.from(new Set(mapped.map((m) => m.rubro))).sort();
  const items = rubro ? mapped.filter((m) => m.rubro === rubro) : mapped;

  res.json({ items, families, rubros });
});

app.post('/api/blind-sheet/log-print', requireAuth, (req: AuthenticatedRequest, res) => {
  const { documentUid, locationId, family, rubro, itemsCount, countNumber } = req.body as {
    documentUid?: string;
    locationId?: number;
    family?: string;
    rubro?: string;
    itemsCount?: number;
    countNumber?: string;
  };

  logAudit({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'BLIND_SHEET_GENERATED',
    entityType: 'BLIND_SHEET',
    entityId: documentUid || '',
    locationId: locationId || null,
    newValue: { documentUid, countNumber, family, rubro, itemsCount },
    ipAddress: getClientIp(req),
  });

  res.json({ ok: true });
});

app.get('/api/counts', requireAuth, (req: AuthenticatedRequest, res) => {
  const statusFilter = String(req.query.status || '').trim();
  const locationId = req.query.locationId ? Number(req.query.locationId) : null;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (req.user!.role === UserRole.CONTADOR) {
    conditions.push('c.assigned_counter_id = ?');
    params.push(req.user!.id);
  } else if (req.user!.role === UserRole.RESPONSABLE_DEPOSITO) {
    if (req.user!.assignedLocationIds.length === 0) {
      res.json({ counts: [] });
      return;
    }
    conditions.push(
      `c.location_id IN (${req.user!.assignedLocationIds.map(() => '?').join(',')})`
    );
    params.push(...req.user!.assignedLocationIds);
  }

  if (statusFilter) {
    conditions.push('c.status = ?');
    params.push(statusFilter);
  }
  if (locationId) {
    conditions.push('c.location_id = ?');
    params.push(locationId);
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT c.*, l.name as location_name, l.code as location_code, l.group_type as location_group,
        uc.full_name as counter_name, uw.full_name as warehouse_manager_name,
        (SELECT COUNT(*) FROM count_items ci WHERE ci.count_id = c.id) as items_count,
        (SELECT COUNT(*) FROM count_items ci WHERE ci.count_id = c.id AND ci.final_counted_qty IS NOT NULL) as counted_items_count,
        (SELECT COUNT(*) FROM count_items ci WHERE ci.count_id = c.id AND ci.reconciliation_result IN ('FALTANTE', 'SOBRANTE')) as discrepancies_count
       FROM counts c
       JOIN locations l ON l.id = c.location_id
       JOIN users uc ON uc.id = c.assigned_counter_id
       LEFT JOIN users uw ON uw.id = c.warehouse_manager_id
       ${whereSql}
       ORDER BY c.scheduled_date DESC, c.id DESC`
    )
    .all(...params) as Array<Record<string, unknown>>;

  // Blind count protection: hide discrepancy summary from CONTADOR while unsubmitted
  const sanitized = rows.map((r) => {
    if (
      req.user!.role === UserRole.CONTADOR &&
      ['PROGRAMADO', 'EN_PROGRESO', 'RECONTEO_SOLICITADO'].includes(String(r.status))
    ) {
      return { ...r, discrepancies_count: null };
    }
    return r;
  });

  res.json({ counts: sanitized });
});

app.get('/api/counts/:id', requireAuth, (req: AuthenticatedRequest, res) => {
  const countId = Number(req.params.id);
  const countRow = db
    .prepare(
      `SELECT c.*, l.name as location_name, l.code as location_code, l.group_type as location_group,
        uc.full_name as counter_name, uc.username as counter_username,
        uw.full_name as warehouse_manager_name, ucb.full_name as created_by_name
       FROM counts c
       JOIN locations l ON l.id = c.location_id
       JOIN users uc ON uc.id = c.assigned_counter_id
       LEFT JOIN users uw ON uw.id = c.warehouse_manager_id
       JOIN users ucb ON ucb.id = c.created_by_user_id
       WHERE c.id = ?`
    )
    .get(countId) as Record<string, unknown> | undefined;

  if (!countRow) {
    res.status(404).json({ error: 'Conteo no encontrado.' });
    return;
  }

  if (
    req.user!.role === UserRole.CONTADOR &&
    Number(countRow.assigned_counter_id) !== req.user!.id
  ) {
    res.status(403).json({ error: 'Solo puede consultar los conteos asignados a su usuario.' });
    return;
  }

  if (
    req.user!.role === UserRole.RESPONSABLE_DEPOSITO &&
    !userCanAccessLocation(req.user!, Number(countRow.location_id))
  ) {
    res.status(403).json({ error: 'No tiene permisos para esta ubicación.' });
    return;
  }

  const rawItems = db
    .prepare(
      `SELECT ci.*, p.sku, p.description, p.alias, p.family, p.brand, p.unit_of_measure,
        ur.full_name as regularized_by_name
       FROM count_items ci
       JOIN products p ON p.id = ci.product_id
       LEFT JOIN users ur ON ur.id = ci.regularized_by_user_id
       WHERE ci.count_id = ?
       ORDER BY p.description ASC`
    )
    .all(countId) as Array<Record<string, unknown>>;

  const isBlindStageForCounter =
    req.user!.role !== UserRole.JEFE_STOCK &&
    ['PROGRAMADO', 'EN_PROGRESO', 'RECONTEO_SOLICITADO'].includes(String(countRow.status));

  const items = rawItems.map((it) => {
    const attachments = db
      .prepare("SELECT * FROM attachments WHERE entity_type = 'COUNT_ITEM' AND entity_id = ?")
      .all(it.id);

    if (isBlindStageForCounter) {
      return {
        id: it.id,
        count_id: it.count_id,
        product_id: it.product_id,
        sku: it.sku,
        description: it.description,
        alias: it.alias,
        family: it.family,
        brand: it.brand,
        unit_of_measure: it.unit_of_measure,
        bulk_qty: it.bulk_qty,
        loose_qty: it.loose_qty,
        counted_qty: it.counted_qty,
        recount_bulk_qty: it.recount_bulk_qty,
        recount_loose_qty: it.recount_loose_qty,
        recount_qty: it.recount_qty,
        final_counted_qty: it.final_counted_qty,
        counter_observations: it.counter_observations,
        recount_requested_reason: it.recount_requested_reason,
        snapshot_erp_stock: null,
        snapshot_committed_stock: null,
        difference: null,
        reconciliation_result: null,
        historical_alert_text: null,
        attachments,
      };
    }

    return { ...it, attachments };
  });

  // Check movements occurring after count snapshot creation (Section 15)
  const productIds = rawItems.map((it) => Number(it.product_id));
  let postSnapshotMovements: Array<Record<string, unknown>> = [];
  if (productIds.length > 0 && req.user!.role === UserRole.JEFE_STOCK) {
    postSnapshotMovements = db
      .prepare(
        `SELECT im.*, p.sku, p.description
         FROM inventory_movements im
         JOIN products p ON p.id = im.product_id
         WHERE im.location_id = ?
           AND im.product_id IN (${productIds.map(() => '?').join(',')})
           AND im.created_at > ?
         ORDER BY im.created_at DESC`
      )
      .all(countRow.location_id, ...productIds, countRow.created_at) as Array<
      Record<string, unknown>
    >;
  }

  const sheetAttachments = db
    .prepare("SELECT * FROM attachments WHERE entity_type IN ('COUNT_SHEET', 'ADJUSTMENT') AND entity_id = ?")
    .all(countId);

  res.json({
    count: countRow,
    items,
    isBlindRestricted: isBlindStageForCounter,
    postSnapshotMovements,
    sheetAttachments,
  });
});

app.post('/api/counts', requireAuth, requireRole(UserRole.JEFE_STOCK), (req: AuthenticatedRequest, res) => {
  const { locationId, scheduledDate, assignedCounterId, productIds, weeklyGoalTag } = req.body as {
    locationId?: number;
    scheduledDate?: string;
    assignedCounterId?: number;
    productIds?: number[];
    weeklyGoalTag?: string;
  };

  if (!locationId || !scheduledDate || !assignedCounterId || !Array.isArray(productIds) || productIds.length === 0) {
    res.status(400).json({
      error: 'Ubicación, fecha programada, responsable de conteo y al menos un artículo son requeridos.',
    });
    return;
  }

  const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(locationId) as
    | Record<string, unknown>
    | undefined;
  if (!loc) {
    res.status(404).json({ error: 'Ubicación no encontrada.' });
    return;
  }

  const countNumber = nextSequenceNumber('CNT', 'counts', 'count_number');
  const documentUid = `DOC-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;

  const createTx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO counts (
          count_number, document_uid, location_id, scheduled_date,
          assigned_counter_id, warehouse_manager_id, created_by_user_id,
          status, weekly_goal_tag
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PROGRAMADO', ?)`
      )
      .run(
        countNumber,
        documentUid,
        locationId,
        scheduledDate,
        assignedCounterId,
        loc.manager_user_id || null,
        req.user!.id,
        (weeklyGoalTag || '').trim()
      );

    const countId = Number(info.lastInsertRowid);
    const insertItem = db.prepare(
      `INSERT INTO count_items (
        count_id, product_id, snapshot_erp_stock, snapshot_committed_stock,
        snapshot_cost_price, historical_alert_text
      ) VALUES (?, ?, ?, ?, ?, ?)`
    );

    for (const pid of productIds) {
      let bal = db
        .prepare(
          `SELECT ib.erp_physical_stock, ib.committed_stock, p.cost_price
           FROM inventory_balances ib
           JOIN products p ON p.id = ib.product_id
           WHERE ib.product_id = ? AND ib.location_id = ?`
        )
        .get(pid, locationId) as
        | { erp_physical_stock: number; committed_stock: number; cost_price: number | null }
        | undefined;

      if (!bal) {
        const prod = db
          .prepare('SELECT id, cost_price FROM products WHERE id = ?')
          .get(pid) as { id: number; cost_price: number | null } | undefined;
        if (!prod) continue;
        db.prepare(
          `INSERT OR IGNORE INTO inventory_balances (
            product_id, location_id, erp_physical_stock, committed_stock, review_stock, damaged_stock, available_stock
          ) VALUES (?, ?, 0, 0, 0, 0, 0)`
        ).run(pid, locationId);
        bal = { erp_physical_stock: 0, committed_stock: 0, cost_price: prod.cost_price };
      }

      const alertText = buildHistoricalAlertForItem(pid, locationId);
      insertItem.run(
        countId,
        pid,
        bal.erp_physical_stock,
        bal.committed_stock,
        bal.cost_price,
        alertText
      );
    }

    createNotification({
      targetUserId: assignedCounterId,
      severity: 'INFO',
      title: `Nuevo conteo asignado: ${countNumber}`,
      message: `Se programó conteo ciego en ${loc.name} para el ${scheduledDate} (${productIds.length} artículos).`,
      entityType: 'COUNT',
      entityId: countId,
    });

    logAudit({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'COUNT_CREATED',
      entityType: 'COUNT',
      entityId: countId,
      locationId,
      newValue: { countNumber, scheduledDate, assignedCounterId, itemsCount: productIds.length },
      ipAddress: getClientIp(req),
    });

    return { countId, countNumber, documentUid };
  });

  const created = createTx();
  res.status(201).json(created);
});

app.post(
  '/api/counts/batch-plan',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK),
  (req: AuthenticatedRequest, res) => {
    const { locationId, scheduledDate, assignments, weeklyGoalTag } = req.body as {
      locationId?: number;
      scheduledDate?: string;
      weeklyGoalTag?: string;
      assignments?: Array<{ counterId: number; productIds: number[] }>;
    };

    if (!locationId || !scheduledDate || !Array.isArray(assignments) || assignments.length === 0) {
      res.status(400).json({ error: 'Faltan datos de programación.' });
      return;
    }

    const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(locationId) as
      | Record<string, unknown>
      | undefined;
    if (!loc) {
      res.status(404).json({ error: 'Ubicación no encontrada.' });
      return;
    }

    const createdCounts: Array<{ countId: number; countNumber: string; counterId: number }> = [];

    const tx = db.transaction(() => {
      for (const a of assignments) {
        if (!a.productIds || a.productIds.length === 0) continue;
        const countNumber = nextSequenceNumber('CNT', 'counts', 'count_number');
        const documentUid = `DOC-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;

        const info = db
          .prepare(
            `INSERT INTO counts (
              count_number, document_uid, location_id, scheduled_date,
              assigned_counter_id, warehouse_manager_id, created_by_user_id,
              status, weekly_goal_tag
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PROGRAMADO', ?)`
          )
          .run(
            countNumber,
            documentUid,
            locationId,
            scheduledDate,
            a.counterId,
            loc.manager_user_id || null,
            req.user!.id,
            (weeklyGoalTag || '').trim()
          );

        const countId = Number(info.lastInsertRowid);
        const insertItem = db.prepare(
          `INSERT INTO count_items (
            count_id, product_id, snapshot_erp_stock, snapshot_committed_stock,
            snapshot_cost_price, historical_alert_text
          ) VALUES (?, ?, ?, ?, ?, ?)`
        );

        for (const pid of a.productIds) {
          let bal = db
            .prepare(
              `SELECT ib.erp_physical_stock, ib.committed_stock, p.cost_price
               FROM inventory_balances ib
               JOIN products p ON p.id = ib.product_id
               WHERE ib.product_id = ? AND ib.location_id = ?`
            )
            .get(pid, locationId) as
            | { erp_physical_stock: number; committed_stock: number; cost_price: number | null }
            | undefined;

          if (!bal) {
            const prod = db
              .prepare('SELECT id, cost_price FROM products WHERE id = ?')
              .get(pid) as { id: number; cost_price: number | null } | undefined;
            if (!prod) continue;
            db.prepare(
              `INSERT OR IGNORE INTO inventory_balances (
                product_id, location_id, erp_physical_stock, committed_stock, review_stock, damaged_stock, available_stock
              ) VALUES (?, ?, 0, 0, 0, 0, 0)`
            ).run(pid, locationId);
            bal = { erp_physical_stock: 0, committed_stock: 0, cost_price: prod.cost_price };
          }

          const alertText = buildHistoricalAlertForItem(pid, locationId);
          insertItem.run(
            countId,
            pid,
            bal.erp_physical_stock,
            bal.committed_stock,
            bal.cost_price,
            alertText
          );
        }

        createNotification({
          targetUserId: a.counterId,
          severity: 'INFO',
          title: `Conteo asignado: ${countNumber}`,
          message: `Conteo en ${loc.name} (${a.productIds.length} artículos) programado para ${scheduledDate}.`,
          entityType: 'COUNT',
          entityId: countId,
        });

        createdCounts.push({ countId, countNumber, counterId: a.counterId });
      }
    });

    tx();
    res.status(201).json({ createdCounts });
  }
);

app.post('/api/counts/:id/mark-printed', requireAuth, (req: AuthenticatedRequest, res) => {
  const countId = Number(req.params.id);
  db.prepare(
    "UPDATE counts SET blind_printed_at = COALESCE(blind_printed_at, datetime('now')), status = CASE WHEN status = 'PROGRAMADO' THEN 'EN_PROGRESO' ELSE status END WHERE id = ?"
  ).run(countId);
  logAudit({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'BLIND_SHEET_PRINTED',
    entityType: 'COUNT',
    entityId: countId,
    ipAddress: getClientIp(req),
  });
  res.json({ ok: true });
});

app.post('/api/counts/:id/submit-results', requireAuth, (req: AuthenticatedRequest, res) => {
  const countId = Number(req.params.id);
  const countRow = db.prepare('SELECT * FROM counts WHERE id = ?').get(countId) as
    | Record<string, unknown>
    | undefined;
  if (!countRow) {
    res.status(404).json({ error: 'Conteo no encontrado.' });
    return;
  }

  if (countRow.status === CountStatus.CERRADO) {
    res.status(403).json({ error: 'El conteo está cerrado y no admite modificaciones.' });
    return;
  }

  if (req.user!.role === UserRole.RESPONSABLE_DEPOSITO) {
    res.status(403).json({ error: 'El responsable de depósito no puede modificar cantidades informadas.' });
    return;
  }

  if (
    req.user!.role === UserRole.CONTADOR &&
    (Number(countRow.assigned_counter_id) !== req.user!.id ||
      ![CountStatus.PROGRAMADO, CountStatus.EN_PROGRESO, CountStatus.RECONTEO_SOLICITADO].includes(
        countRow.status as CountStatus
      ))
  ) {
    res.status(403).json({
      error: 'No puede modificar un conteo ya enviado o asignado a otro responsable.',
    });
    return;
  }

  const { items, counterSignatureName, submitForReview } = req.body as {
    items?: Array<{
      itemId: number;
      bulkQty?: number | null;
      looseQty?: number | null;
      countedQty?: number | null;
      observations?: string;
    }>;
    counterSignatureName?: string;
    submitForReview?: boolean;
  };

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'Ingrese las cantidades contadas.' });
    return;
  }

  const isRecount = countRow.status === CountStatus.RECONTEO_SOLICITADO;

  const parseOptionalNonNeg = (val: unknown): number | null => {
    if (val === null || val === undefined || val === '') return null;
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error('Las cantidades ingresadas deben ser números válidos mayores o iguales a cero.');
    }
    return n;
  };

  const tx = db.transaction(() => {
    for (const entry of items) {
      const existing = db
        .prepare('SELECT * FROM count_items WHERE id = ? AND count_id = ?')
        .get(entry.itemId, countId) as Record<string, unknown> | undefined;
      if (!existing) continue;

      const parsedBulk = parseOptionalNonNeg(entry.bulkQty);
      const parsedLoose = parseOptionalNonNeg(entry.looseQty);

      if (submitForReview && (parsedBulk === null || parsedLoose === null)) {
        throw new Error(
          'Debe completar tanto la columna "Unidades / Bultos" como "Unidades Sueltas" en todos los artículos antes de enviar el registro.'
        );
      }

      // If neither column has a value yet, preserve observations only in draft mode
      if (parsedBulk === null || parsedLoose === null) {
        if (isRecount) {
          db.prepare(
            `UPDATE count_items SET
              recount_bulk_qty = ?,
              recount_loose_qty = ?,
              recount_qty = NULL,
              counter_observations = COALESCE(NULLIF(?, ''), counter_observations),
              updated_at = datetime('now')
             WHERE id = ?`
          ).run(parsedBulk, parsedLoose, entry.observations || '', existing.id);
        } else {
          db.prepare(
            `UPDATE count_items SET
              bulk_qty = ?,
              loose_qty = ?,
              counted_qty = NULL,
              final_counted_qty = NULL,
              difference = NULL,
              reconciliation_result = NULL,
              counter_observations = ?,
              updated_at = datetime('now')
             WHERE id = ?`
          ).run(parsedBulk, parsedLoose, entry.observations || '', existing.id);
        }
        continue;
      }

      const qty = Math.round((parsedBulk + parsedLoose) * 10000) / 10000;
      const snapshotErp = Number(existing.snapshot_erp_stock);
      const diff = Math.round((qty - snapshotErp) * 10000) / 10000;
      const recResult =
        diff === 0
          ? ReconciliationResult.COINCIDENCIA
          : diff < 0
            ? ReconciliationResult.FALTANTE
            : ReconciliationResult.SOBRANTE;

      const histAlert =
        diff !== 0
          ? buildHistoricalAlertForItem(Number(existing.product_id), Number(countRow.location_id))
          : String(existing.historical_alert_text || '');

      if (isRecount) {
        db.prepare(
          `UPDATE count_items SET
            recount_bulk_qty = ?,
            recount_loose_qty = ?,
            recount_qty = ?,
            final_counted_qty = ?,
            difference = ?,
            reconciliation_result = ?,
            counter_observations = COALESCE(NULLIF(?, ''), counter_observations),
            historical_alert_text = ?,
            updated_at = datetime('now')
           WHERE id = ?`
        ).run(parsedBulk, parsedLoose, qty, qty, diff, recResult, entry.observations || '', histAlert, existing.id);
      } else {
        db.prepare(
          `UPDATE count_items SET
            bulk_qty = ?,
            loose_qty = ?,
            counted_qty = ?,
            final_counted_qty = ?,
            difference = ?,
            reconciliation_result = ?,
            counter_observations = ?,
            historical_alert_text = ?,
            updated_at = datetime('now')
           WHERE id = ?`
        ).run(parsedBulk, parsedLoose, qty, qty, diff, recResult, entry.observations || '', histAlert, existing.id);
      }

      if (submitForReview) {
        db.prepare(
          "UPDATE inventory_balances SET last_counted_at = datetime('now') WHERE product_id = ? AND location_id = ?"
        ).run(existing.product_id, countRow.location_id);
      }
    }

    if (submitForReview) {
      const missingSql = isRecount
        ? 'SELECT COUNT(*) as cnt FROM count_items WHERE count_id = ? AND (recount_bulk_qty IS NULL OR recount_loose_qty IS NULL OR final_counted_qty IS NULL)'
        : 'SELECT COUNT(*) as cnt FROM count_items WHERE count_id = ? AND (bulk_qty IS NULL OR loose_qty IS NULL OR final_counted_qty IS NULL)';
      const missing = (db.prepare(missingSql).get(countId) as { cnt: number }).cnt;

      if (missing > 0) {
        throw new Error(
          `Validación requerida: faltan completar Unidades / Bultos y/o Unidades Sueltas en ${missing} artículo(s) antes de enviar a revisión.`
        );
      }

      db.prepare(
        `UPDATE counts SET
          status = 'ENVIADO_REVISION',
          submitted_at = datetime('now'),
          counter_signature_name = ?,
          counter_signed_at = datetime('now')
         WHERE id = ?`
      ).run(counterSignatureName?.trim() || req.user!.fullName, countId);

      const discrepancies = (
        db
          .prepare(
            "SELECT COUNT(*) as cnt FROM count_items WHERE count_id = ? AND reconciliation_result IN ('FALTANTE', 'SOBRANTE')"
          )
          .get(countId) as { cnt: number }
      ).cnt;

      createNotification({
        targetRole: UserRole.JEFE_STOCK,
        severity: discrepancies > 0 ? 'ALTA' : 'INFO',
        title: `Conteo ${countRow.count_number} listo para validación`,
        message: `Enviado por ${req.user!.fullName}. Se detectaron ${discrepancies} diferencia(s) en la conciliación automática.`,
        entityType: 'COUNT',
        entityId: countId,
      });
    } else {
      db.prepare("UPDATE counts SET status = 'EN_PROGRESO' WHERE id = ? AND status = 'PROGRAMADO'").run(
        countId
      );
    }

    logAudit({
      userId: req.user!.id,
      username: req.user!.username,
      action: submitForReview ? 'COUNT_SUBMITTED_FOR_REVIEW' : 'COUNT_DRAFT_SAVED',
      entityType: 'COUNT',
      entityId: countId,
      locationId: Number(countRow.location_id),
      newValue: { itemsUpdated: items.length, isRecount, submitForReview },
      ipAddress: getClientIp(req),
    });
  });

  try {
    tx();
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post(
  '/api/counts/:id/import-results-excel',
  requireAuth,
  memoryUpload.single('file'),
  (req: AuthenticatedRequest, res) => {
    const countId = Number(req.params.id);
    if (!req.file) {
      res.status(400).json({ error: 'Adjunte el archivo Excel o CSV con los resultados.' });
      return;
    }

    try {
      const parsed = parseExcelBuffer(req.file.buffer);
      const skuCol = parsed.suggestedMapping.sku || parsed.headers[0];
      const bulkCol = parsed.headers.find((h) => h.toLowerCase().includes('bult'));
      const looseCol = parsed.headers.find((h) => h.toLowerCase().includes('suelt'));
      const qtyCol =
        parsed.suggestedMapping.erpStock ||
        parsed.headers.find((h) => h.toLowerCase().includes('cant') || h.toLowerCase().includes('fis')) ||
        parsed.headers[1];
      const obsCol = parsed.headers.find((h) => h.toLowerCase().includes('obs'));

      const countItems = db
        .prepare(
          `SELECT ci.id, p.sku FROM count_items ci JOIN products p ON p.id = ci.product_id WHERE ci.count_id = ?`
        )
        .all(countId) as Array<{ id: number; sku: string }>;

      const skuMap = new Map(countItems.map((i) => [i.sku.trim().toUpperCase(), i.id]));
      const matched: Array<{
        itemId: number;
        sku: string;
        bulkQty: number | null;
        looseQty: number | null;
        countedQty: number;
        observations: string;
      }> = [];

      const parseNum = (val: unknown): number | null => {
        const s = String(val ?? '').trim().replace(',', '.');
        if (!s) return null;
        const n = Number(s);
        return Number.isFinite(n) && n >= 0 ? n : null;
      };

      for (const row of parsed.rows) {
        const sku = String(row[skuCol] ?? '').trim().toUpperCase();
        const itemId = skuMap.get(sku);
        if (!itemId) continue;

        const bulkVal = bulkCol ? parseNum(row[bulkCol]) : null;
        const looseVal = looseCol ? parseNum(row[looseCol]) : null;
        const singleVal = qtyCol ? parseNum(row[qtyCol]) : null;

        if (bulkCol || looseCol) {
          if (bulkVal === null && looseVal === null) continue;
          matched.push({
            itemId,
            sku,
            bulkQty: bulkVal,
            looseQty: looseVal,
            countedQty: (bulkVal ?? 0) + (looseVal ?? 0),
            observations: obsCol ? String(row[obsCol] ?? '').trim() : '',
          });
        } else if (singleVal !== null) {
          matched.push({
            itemId,
            sku,
            bulkQty: singleVal,
            looseQty: 0,
            countedQty: singleVal,
            observations: obsCol ? String(row[obsCol] ?? '').trim() : '',
          });
        }
      }

      res.json({ matchedCount: matched.length, matched });
    } catch (err: unknown) {
      res.status(400).json({ error: (err as Error).message });
    }
  }
);

app.post('/api/counts/:id/warehouse-sign', requireAuth, (req: AuthenticatedRequest, res) => {
  const countId = Number(req.params.id);
  const countRow = db.prepare('SELECT * FROM counts WHERE id = ?').get(countId) as
    | Record<string, unknown>
    | undefined;
  if (!countRow) {
    res.status(404).json({ error: 'Conteo no encontrado.' });
    return;
  }

  if (
    req.user!.role === UserRole.CONTADOR ||
    (req.user!.role === UserRole.RESPONSABLE_DEPOSITO &&
      !userCanAccessLocation(req.user!, Number(countRow.location_id)))
  ) {
    res.status(403).json({ error: 'Solo el responsable de depósito asignado o el Jefe pueden firmar.' });
    return;
  }

  if (countRow.status === CountStatus.CERRADO) {
    res.status(403).json({ error: 'El conteo ya fue cerrado.' });
    return;
  }

  const { signatureName, notes } = req.body as { signatureName?: string; notes?: string };
  db.prepare(
    `UPDATE counts SET
      warehouse_signature_name = ?,
      warehouse_signed_at = datetime('now'),
      warehouse_confirmed_notes = ?
     WHERE id = ?`
  ).run(signatureName?.trim() || req.user!.fullName, (notes || '').trim(), countId);

  logAudit({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'WAREHOUSE_MANAGER_SIGNED',
    entityType: 'COUNT',
    entityId: countId,
    locationId: Number(countRow.location_id),
    newValue: { signatureName: signatureName || req.user!.fullName, notes },
    ipAddress: getClientIp(req),
  });

  res.json({ ok: true });
});

app.post(
  '/api/counts/:id/request-recount',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK),
  (req: AuthenticatedRequest, res) => {
    const countId = Number(req.params.id);
    const { itemReasons, chiefObservations } = req.body as {
      itemReasons?: Array<{ itemId: number; reason: string }>;
      chiefObservations?: string;
    };

    const countRow = db.prepare('SELECT * FROM counts WHERE id = ?').get(countId) as
      | Record<string, unknown>
      | undefined;
    if (!countRow) {
      res.status(404).json({ error: 'Conteo no encontrado.' });
      return;
    }
    if (countRow.status === CountStatus.CERRADO) {
      res.status(403).json({ error: 'No se puede solicitar reconteo sobre un conteo cerrado.' });
      return;
    }

    const tx = db.transaction(() => {
      db.prepare(
        "UPDATE counts SET status = 'RECONTEO_SOLICITADO', chief_notes = ? WHERE id = ?"
      ).run(chiefObservations || '', countId);

      if (Array.isArray(itemReasons)) {
        const upd = db.prepare(
          'UPDATE count_items SET recount_requested_reason = ? WHERE id = ? AND count_id = ?'
        );
        for (const r of itemReasons) {
          upd.run(r.reason, r.itemId, countId);
        }
      }

      createNotification({
        targetUserId: Number(countRow.assigned_counter_id),
        severity: 'ALTA',
        title: `Reconteo solicitado: ${countRow.count_number}`,
        message: chiefObservations || 'El Jefe de Control de Stock solicitó una segunda verificación física.',
        entityType: 'COUNT',
        entityId: countId,
      });

      logAudit({
        userId: req.user!.id,
        username: req.user!.username,
        action: 'RECOUNT_REQUESTED',
        entityType: 'COUNT',
        entityId: countId,
        locationId: Number(countRow.location_id),
        newValue: { chiefObservations, itemReasons },
        ipAddress: getClientIp(req),
      });
    });

    tx();
    res.json({ ok: true });
  }
);

app.post(
  '/api/counts/:id/validate',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK),
  (req: AuthenticatedRequest, res) => {
    const countId = Number(req.params.id);
    const { chiefNotes } = req.body as { chiefNotes?: string };
    const countRow = db.prepare('SELECT * FROM counts WHERE id = ?').get(countId) as
      | Record<string, unknown>
      | undefined;
    if (!countRow) {
      res.status(404).json({ error: 'Conteo no encontrado.' });
      return;
    }
    if (countRow.status === CountStatus.CERRADO) {
      res.status(403).json({ error: 'El conteo ya está cerrado.' });
      return;
    }

    db.prepare(
      "UPDATE counts SET status = 'VALIDADO', validated_at = datetime('now'), chief_notes = ? WHERE id = ?"
    ).run(chiefNotes || '', countId);

    logAudit({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'COUNT_VALIDATED',
      entityType: 'COUNT',
      entityId: countId,
      locationId: Number(countRow.location_id),
      newValue: { chiefNotes },
      ipAddress: getClientIp(req),
    });

    res.json({ ok: true });
  }
);

app.post(
  '/api/counts/:id/items/:itemId/regularize',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK),
  (req: AuthenticatedRequest, res) => {
    const countId = Number(req.params.id);
    const itemId = Number(req.params.itemId);
    const countRow = db.prepare('SELECT * FROM counts WHERE id = ?').get(countId) as
      | Record<string, unknown>
      | undefined;
    if (!countRow) {
      res.status(404).json({ error: 'Conteo no encontrado.' });
      return;
    }
    if (countRow.status === CountStatus.CERRADO) {
      res.status(403).json({ error: 'No se pueden modificar regularizaciones de un conteo cerrado.' });
      return;
    }

    const itemRow = db
      .prepare('SELECT * FROM count_items WHERE id = ? AND count_id = ?')
      .get(itemId, countId) as Record<string, unknown> | undefined;
    if (!itemRow) {
      res.status(404).json({ error: 'Ítem de conteo no encontrado.' });
      return;
    }

    const {
      adjustmentStatus,
      erpOperationNumber,
      regularizationDate,
      noAdjustmentReason,
      adjustmentNotes,
    } = req.body as {
      adjustmentStatus?: AdjustmentOperationType;
      erpOperationNumber?: string;
      regularizationDate?: string;
      noAdjustmentReason?: string;
      adjustmentNotes?: string;
    };

    if (!adjustmentStatus || !Object.values(AdjustmentOperationType).includes(adjustmentStatus)) {
      res.status(400).json({ error: 'Tipo de operación inválido.' });
      return;
    }

    if (
      (adjustmentStatus === AdjustmentOperationType.AJUSTE ||
        adjustmentStatus === AdjustmentOperationType.MOVIMIENTO) &&
      (!erpOperationNumber || !erpOperationNumber.trim())
    ) {
      res.status(400).json({
        error: 'Debe ingresar el número de ajuste o movimiento registrado en el ERP.',
      });
      return;
    }

    if (
      adjustmentStatus === AdjustmentOperationType.SIN_AJUSTE &&
      (!noAdjustmentReason || !noAdjustmentReason.trim())
    ) {
      res.status(400).json({
        error: 'Cuando selecciona "Sin ajuste", debe indicar expresamente el motivo.',
      });
      return;
    }

    db.prepare(
      `UPDATE count_items SET
        adjustment_status = ?,
        erp_operation_number = ?,
        regularization_date = ?,
        regularized_by_user_id = ?,
        no_adjustment_reason = ?,
        adjustment_notes = ?,
        updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      adjustmentStatus,
      (erpOperationNumber || '').trim(),
      regularizationDate || new Date().toISOString().slice(0, 10),
      req.user!.id,
      (noAdjustmentReason || '').trim(),
      (adjustmentNotes || '').trim(),
      itemId
    );

    logAudit({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'COUNT_ITEM_REGULARIZED',
      entityType: 'COUNT_ITEM',
      entityId: itemId,
      locationId: Number(countRow.location_id),
      oldValue: {
        adjustmentStatus: itemRow.adjustment_status,
        erpOperationNumber: itemRow.erp_operation_number,
      },
      newValue: { adjustmentStatus, erpOperationNumber, noAdjustmentReason, adjustmentNotes },
      ipAddress: getClientIp(req),
    });

    res.json({ ok: true });
  }
);

app.post(
  '/api/counts/:id/close',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK),
  (req: AuthenticatedRequest, res) => {
    const countId = Number(req.params.id);
    const { chiefSignatureName } = req.body as { chiefSignatureName?: string };

    const countRow = db.prepare('SELECT * FROM counts WHERE id = ?').get(countId) as
      | Record<string, unknown>
      | undefined;
    if (!countRow) {
      res.status(404).json({ error: 'Conteo no encontrado.' });
      return;
    }
    if (countRow.status === CountStatus.CERRADO) {
      res.status(400).json({ error: 'El conteo ya se encuentra cerrado.' });
      return;
    }
    if (countRow.status !== CountStatus.VALIDADO) {
      res.status(400).json({
        error: 'Condición de cierre incumplida: el conteo debe ser VALIDADO por el Jefe antes del cierre.',
      });
      return;
    }
    if (!chiefSignatureName || !chiefSignatureName.trim()) {
      res.status(400).json({
        error: 'Condición de cierre incumplida: debe registrar la firma final del Jefe de Control de Stock.',
      });
      return;
    }

    const items = db
      .prepare('SELECT * FROM count_items WHERE count_id = ?')
      .all(countId) as Array<Record<string, unknown>>;

    for (const it of items) {
      if (it.final_counted_qty === null || it.reconciliation_result === null) {
        res.status(400).json({
          error: 'Condición de cierre incumplida: todos los artículos deben tener resultado físico y conciliación.',
        });
        return;
      }
      if (it.reconciliation_result !== ReconciliationResult.COINCIDENCIA) {
        if (it.adjustment_status === AdjustmentOperationType.PENDIENTE) {
          res.status(400).json({
            error: 'Condición de cierre incumplida: existen diferencias sin regularizar ni justificar como "Sin ajuste".',
          });
          return;
        }
        if (
          (it.adjustment_status === AdjustmentOperationType.AJUSTE ||
            it.adjustment_status === AdjustmentOperationType.MOVIMIENTO) &&
          !String(it.erp_operation_number || '').trim()
        ) {
          res.status(400).json({
            error: 'Condición de cierre incumplida: falta el número de operación del ERP en una regularización.',
          });
          return;
        }
      }
    }

    const closeTx = db.transaction(() => {
      for (const it of items) {
        if (
          it.reconciliation_result !== ReconciliationResult.COINCIDENCIA &&
          (it.adjustment_status === AdjustmentOperationType.AJUSTE ||
            it.adjustment_status === AdjustmentOperationType.MOVIMIENTO)
        ) {
          const diff = Number(it.difference || 0);
          db.prepare(
            `INSERT INTO inventory_movements (
              product_id, location_id, movement_type, quantity_delta, stock_bucket,
              reference_type, reference_id, erp_operation_number, user_id, notes
            ) VALUES (?, ?, ?, ?, 'PHYSICAL', 'COUNT_CLOSURE', ?, ?, ?, ?)`
          ).run(
            it.product_id,
            countRow.location_id,
            it.adjustment_status === AdjustmentOperationType.AJUSTE
              ? 'ERP_ADJUSTMENT'
              : 'ERP_MOVEMENT',
            diff,
            String(countId),
            it.erp_operation_number,
            req.user!.id,
            `Cierre conteo ${countRow.count_number} — Op. ERP ${it.erp_operation_number}`
          );

          db.prepare(
            `UPDATE inventory_balances
             SET erp_physical_stock = erp_physical_stock + ?
             WHERE product_id = ? AND location_id = ?`
          ).run(diff, it.product_id, countRow.location_id);

          recomputeAvailableStock(Number(it.product_id), Number(countRow.location_id));
        }
      }

      db.prepare(
        `UPDATE counts SET
          status = 'CERRADO',
          closed_at = datetime('now'),
          chief_signature_name = ?,
          chief_signed_at = datetime('now')
         WHERE id = ?`
      ).run(chiefSignatureName.trim(), countId);

      logAudit({
        userId: req.user!.id,
        username: req.user!.username,
        action: 'COUNT_CLOSED_PERMANENTLY',
        entityType: 'COUNT',
        entityId: countId,
        locationId: Number(countRow.location_id),
        newValue: { chiefSignatureName: chiefSignatureName.trim(), itemsCount: items.length },
        ipAddress: getClientIp(req),
      });
    });

    closeTx();
    res.json({ ok: true });
  }
);

// ============================================================================
// 7. ATTACHMENTS (PHOTOS & ERP EVIDENCE DOCUMENTS)
// ============================================================================

app.post(
  '/api/attachments',
  requireAuth,
  diskUpload.single('file'),
  (req: AuthenticatedRequest, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No se recibió archivo.' });
      return;
    }

    const { entityType, entityId } = req.body as { entityType?: string; entityId?: string };
    if (
      !entityType ||
      !['COUNT_ITEM', 'COUNT_SHEET', 'ADJUSTMENT', 'POS_OPERATION'].includes(entityType) ||
      !entityId
    ) {
      res.status(400).json({ error: 'Tipo y referencia de entidad requeridos.' });
      return;
    }

    const info = db
      .prepare(
        `INSERT INTO attachments (entity_type, entity_id, filename, original_name, mime_type, size_bytes, uploaded_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entityType,
        Number(entityId),
        req.file.filename,
        req.file.originalname,
        req.file.mimetype,
        req.file.size,
        req.user!.id
      );

    logAudit({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'ATTACHMENT_UPLOADED',
      entityType,
      entityId: Number(entityId),
      newValue: { originalName: req.file.originalname, sizeBytes: req.file.size },
      ipAddress: getClientIp(req),
    });

    res.status(201).json({
      id: info.lastInsertRowid,
      original_name: req.file.originalname,
      mime_type: req.file.mimetype,
    });
  }
);

app.get('/api/attachments/:id', requireAuth, (req, res) => {
  const attId = Number(req.params.id);
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(attId) as
    | { filename: string; original_name: string; mime_type: string }
    | undefined;
  if (!row) {
    res.status(404).json({ error: 'Archivo no encontrado.' });
    return;
  }

  const resolvedPath = path.resolve(UPLOADS_DIR, row.filename);
  if (!resolvedPath.startsWith(UPLOADS_DIR + path.sep) || !fs.existsSync(resolvedPath)) {
    res.status(404).json({ error: 'Archivo físico no disponible.' });
    return;
  }

  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${row.original_name.replace(/"/g, '')}"`);
  fs.createReadStream(resolvedPath).pipe(res);
});

// ============================================================================
// 8. POINT OF SALE (PUNTO DE VENTA — Section 10)
// ============================================================================

app.get('/api/pos/catalog', requireAuth, (req: AuthenticatedRequest, res) => {
  if (req.user!.role === UserRole.CONTADOR) {
    res.status(403).json({
      error: 'Los contadores no operan en el módulo Punto de Venta ni consultan existencias teóricas.',
    });
    return;
  }

  const locationId = req.query.locationId ? Number(req.query.locationId) : null;
  const search = String(req.query.search || '').trim();

  if (locationId && !userCanAccessLocation(req.user!, locationId)) {
    res.status(403).json({ error: 'No tiene permisos sobre esta ubicación.' });
    return;
  }

  const conds: string[] = [];
  const params: unknown[] = [];

  if (locationId) {
    conds.push('ib.location_id = ?');
    params.push(locationId);
  } else if (req.user!.role !== UserRole.JEFE_STOCK) {
    if (req.user!.assignedLocationIds.length === 0) {
      res.json({ catalog: [] });
      return;
    }
    conds.push(`ib.location_id IN (${req.user!.assignedLocationIds.map(() => '?').join(',')})`);
    params.push(...req.user!.assignedLocationIds);
  }

  if (search) {
    conds.push('(p.sku LIKE ? OR p.description LIKE ? OR p.alias LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  const whereSql = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const catalog = db
    .prepare(
      `SELECT p.id as product_id, p.sku, p.description, p.alias, p.family, p.brand,
        p.unit_of_measure, p.sale_price, ib.location_id, l.name as location_name,
        ib.erp_physical_stock, ib.committed_stock, ib.pos_pending_sync,
        ib.review_stock, ib.available_stock
       FROM inventory_balances ib
       JOIN products p ON p.id = ib.product_id
       JOIN locations l ON l.id = ib.location_id
       ${whereSql}
       ORDER BY p.description ASC
       LIMIT 300`
    )
    .all(...params);

  res.json({ catalog });
});

app.get('/api/pos/operations', requireAuth, (req: AuthenticatedRequest, res) => {
  if (req.user!.role === UserRole.CONTADOR) {
    res.status(403).json({ error: 'Acceso denegado.' });
    return;
  }
  const locationId = req.query.locationId ? Number(req.query.locationId) : null;
  const status = String(req.query.status || '').trim();

  const conds: string[] = [];
  const params: unknown[] = [];

  if (req.user!.role !== UserRole.JEFE_STOCK) {
    if (req.user!.assignedLocationIds.length === 0) {
      res.json({ operations: [] });
      return;
    }
    conds.push(`po.location_id IN (${req.user!.assignedLocationIds.map(() => '?').join(',')})`);
    params.push(...req.user!.assignedLocationIds);
  }
  if (locationId) {
    conds.push('po.location_id = ?');
    params.push(locationId);
  }
  if (status) {
    conds.push('po.status = ?');
    params.push(status);
  }

  const whereSql = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const ops = db
    .prepare(
      `SELECT po.*, l.name as location_name, u.full_name as created_by_name
       FROM pos_operations po
       JOIN locations l ON l.id = po.location_id
       JOIN users u ON u.id = po.created_by_user_id
       ${whereSql}
       ORDER BY po.created_at DESC LIMIT 100`
    )
    .all(...params) as Array<Record<string, unknown>>;

  const enriched = ops.map((op) => {
    const items = db
      .prepare(
        `SELECT poi.*, p.sku, p.description, p.unit_of_measure
         FROM pos_operation_items poi
         JOIN products p ON p.id = poi.product_id
         WHERE poi.operation_id = ?`
      )
      .all(op.id);
    return { ...op, items };
  });

  res.json({ operations: enriched });
});

app.post('/api/pos/operations', requireAuth, (req: AuthenticatedRequest, res) => {
  if (req.user!.role === UserRole.CONTADOR) {
    res.status(403).json({ error: 'Los contadores no pueden registrar operaciones comerciales.' });
    return;
  }

  const { operationType, locationId, customerName, customerDoc, notes, items } = req.body as {
    operationType?: PosOperationType;
    locationId?: number;
    customerName?: string;
    customerDoc?: string;
    notes?: string;
    items?: Array<{ productId: number; quantity: number; unitPrice: number }>;
  };

  if (
    !operationType ||
    !Object.values(PosOperationType).includes(operationType) ||
    !locationId ||
    !Array.isArray(items) ||
    items.length === 0
  ) {
    res.status(400).json({ error: 'Tipo de operación, ubicación y al menos un artículo son requeridos.' });
    return;
  }

  if (!userCanAccessLocation(req.user!, Number(locationId))) {
    res.status(403).json({ error: 'No tiene permisos sobre la ubicación seleccionada.' });
    return;
  }

  if (operationType === PosOperationType.DEVOLUCION && (!notes || !notes.trim())) {
    res.status(400).json({
      error: 'Las devoluciones requieren documentar el motivo y comprobante de referencia.',
    });
    return;
  }

  const opNumber = nextSequenceNumber('POS', 'pos_operations', 'operation_number');
  const initialStatus =
    operationType === PosOperationType.RESERVA
      ? PosOperationStatus.PENDIENTE
      : PosOperationStatus.CONFIRMADA;

  const tx = db.transaction(() => {
    let subtotal = 0;
    for (const item of items) {
      const qty = Number(item.quantity);
      const price = Number(item.unitPrice);
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price < 0) {
        throw new Error('Cantidades y precios deben ser valores positivos.');
      }

      const bal = db
        .prepare('SELECT available_stock FROM inventory_balances WHERE product_id = ? AND location_id = ?')
        .get(item.productId, locationId) as { available_stock: number } | undefined;

      if (!bal) {
        throw new Error('Uno de los artículos no registra balance en la ubicación seleccionada.');
      }

      if (
        (operationType === PosOperationType.VENTA || operationType === PosOperationType.RESERVA) &&
        bal.available_stock < qty
      ) {
        throw new Error(
          `Stock disponible insuficiente (disponible: ${bal.available_stock}, solicitado: ${qty}).`
        );
      }

      subtotal += qty * price;
    }

    const opInfo = db
      .prepare(
        `INSERT INTO pos_operations (
          operation_number, operation_type, location_id, customer_name, customer_doc,
          status, subtotal, total, notes, erp_sync_status, created_by_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'MODULO_INDEPENDIENTE_LOCAL', ?)`
      )
      .run(
        opNumber,
        operationType,
        locationId,
        (customerName || 'Consumidor Final').trim(),
        (customerDoc || '').trim(),
        initialStatus,
        subtotal,
        subtotal,
        (notes || '').trim(),
        req.user!.id
      );

    const opId = Number(opInfo.lastInsertRowid);
    const insItem = db.prepare(
      'INSERT INTO pos_operation_items (operation_id, product_id, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?)'
    );

    for (const item of items) {
      const qty = Number(item.quantity);
      const price = Number(item.unitPrice);
      insItem.run(opId, item.productId, qty, price, qty * price);

      if (operationType === PosOperationType.VENTA) {
        // Record movement without silently overwriting official ERP physical stock
        db.prepare(
          'UPDATE inventory_balances SET pos_pending_sync = pos_pending_sync + ? WHERE product_id = ? AND location_id = ?'
        ).run(qty, item.productId, locationId);
        db.prepare(
          `INSERT INTO inventory_movements (
            product_id, location_id, movement_type, quantity_delta, stock_bucket,
            reference_type, reference_id, user_id, notes
          ) VALUES (?, ?, 'POS_SALE', ?, 'PHYSICAL', 'POS_OPERATION', ?, ?, ?)`
        ).run(item.productId, locationId, -qty, String(opId), req.user!.id, `Venta local ${opNumber}`);
      } else if (operationType === PosOperationType.RESERVA) {
        db.prepare(
          'UPDATE inventory_balances SET committed_stock = committed_stock + ? WHERE product_id = ? AND location_id = ?'
        ).run(qty, item.productId, locationId);
        db.prepare(
          `INSERT INTO inventory_movements (
            product_id, location_id, movement_type, quantity_delta, stock_bucket,
            reference_type, reference_id, user_id, notes
          ) VALUES (?, ?, 'POS_RESERVE', ?, 'COMMITTED', 'POS_OPERATION', ?, ?, ?)`
        ).run(item.productId, locationId, qty, String(opId), req.user!.id, `Reserva ${opNumber}`);
      } else if (operationType === PosOperationType.DEVOLUCION) {
        db.prepare(
          'UPDATE inventory_balances SET review_stock = review_stock + ? WHERE product_id = ? AND location_id = ?'
        ).run(qty, item.productId, locationId);
        db.prepare(
          `INSERT INTO inventory_movements (
            product_id, location_id, movement_type, quantity_delta, stock_bucket,
            reference_type, reference_id, user_id, notes
          ) VALUES (?, ?, 'POS_RETURN', ?, 'REVIEW', 'POS_OPERATION', ?, ?, ?)`
        ).run(
          item.productId,
          locationId,
          qty,
          String(opId),
          req.user!.id,
          `Devolución ${opNumber}: ${notes}`
        );
      }

      recomputeAvailableStock(item.productId, Number(locationId));
    }

    logAudit({
      userId: req.user!.id,
      username: req.user!.username,
      action: `POS_${operationType}_CREATED`,
      entityType: 'POS_OPERATION',
      entityId: opId,
      locationId: Number(locationId),
      newValue: { opNumber, operationType, subtotal, itemsCount: items.length },
      ipAddress: getClientIp(req),
    });

    return { id: opId, operationNumber: opNumber, status: initialStatus, total: subtotal };
  });

  try {
    const result = tx();
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/pos/operations/:id/confirm', requireAuth, (req: AuthenticatedRequest, res) => {
  if (req.user!.role === UserRole.CONTADOR) {
    res.status(403).json({ error: 'Acceso denegado.' });
    return;
  }

  const opId = Number(req.params.id);
  const op = db.prepare('SELECT * FROM pos_operations WHERE id = ?').get(opId) as
    | Record<string, unknown>
    | undefined;
  if (!op) {
    res.status(404).json({ error: 'Operación no encontrada.' });
    return;
  }
  if (op.status !== PosOperationStatus.PENDIENTE || op.operation_type !== PosOperationType.RESERVA) {
    res.status(400).json({ error: 'Solo pueden confirmarse reservas en estado PENDIENTE.' });
    return;
  }

  const items = db
    .prepare('SELECT * FROM pos_operation_items WHERE operation_id = ?')
    .all(opId) as Array<{ product_id: number; quantity: number }>;

  const tx = db.transaction(() => {
    for (const it of items) {
      db.prepare(
        `UPDATE inventory_balances
         SET committed_stock = MAX(0, committed_stock - ?),
             pos_pending_sync = pos_pending_sync + ?
         WHERE product_id = ? AND location_id = ?`
      ).run(it.quantity, it.quantity, it.product_id, op.location_id);

      db.prepare(
        `INSERT INTO inventory_movements (
          product_id, location_id, movement_type, quantity_delta, stock_bucket,
          reference_type, reference_id, user_id, notes
        ) VALUES (?, ?, 'POS_SALE', ?, 'PHYSICAL', 'POS_OPERATION', ?, ?, ?)`
      ).run(
        it.product_id,
        op.location_id,
        -it.quantity,
        String(opId),
        req.user!.id,
        `Reserva ${op.operation_number} convertida en venta confirmada`
      );

      recomputeAvailableStock(it.product_id, Number(op.location_id));
    }

    db.prepare(
      "UPDATE pos_operations SET status = 'CONFIRMADA', updated_at = datetime('now') WHERE id = ?"
    ).run(opId);

    logAudit({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'POS_RESERVATION_CONFIRMED',
      entityType: 'POS_OPERATION',
      entityId: opId,
      locationId: Number(op.location_id),
      ipAddress: getClientIp(req),
    });
  });

  tx();
  res.json({ ok: true });
});

app.post('/api/pos/operations/:id/void', requireAuth, (req: AuthenticatedRequest, res) => {
  if (req.user!.role === UserRole.CONTADOR) {
    res.status(403).json({ error: 'Acceso denegado.' });
    return;
  }

  const opId = Number(req.params.id);
  const { reason } = req.body as { reason?: string };
  if (!reason || !reason.trim()) {
    res.status(400).json({ error: 'Debe especificar el motivo de anulación para mantener trazabilidad.' });
    return;
  }

  const op = db.prepare('SELECT * FROM pos_operations WHERE id = ?').get(opId) as
    | Record<string, unknown>
    | undefined;
  if (!op) {
    res.status(404).json({ error: 'Operación no encontrada.' });
    return;
  }
  if (op.status === PosOperationStatus.ANULADA) {
    res.status(400).json({ error: 'La operación ya fue anulada.' });
    return;
  }

  const items = db
    .prepare('SELECT * FROM pos_operation_items WHERE operation_id = ?')
    .all(opId) as Array<{ product_id: number; quantity: number }>;

  const tx = db.transaction(() => {
    for (const it of items) {
      if (op.operation_type === PosOperationType.RESERVA && op.status === PosOperationStatus.PENDIENTE) {
        db.prepare(
          'UPDATE inventory_balances SET committed_stock = MAX(0, committed_stock - ?) WHERE product_id = ? AND location_id = ?'
        ).run(it.quantity, it.product_id, op.location_id);
      } else if (
        op.operation_type === PosOperationType.VENTA ||
        (op.operation_type === PosOperationType.RESERVA && op.status === PosOperationStatus.CONFIRMADA)
      ) {
        db.prepare(
          'UPDATE inventory_balances SET pos_pending_sync = MAX(0, pos_pending_sync - ?) WHERE product_id = ? AND location_id = ?'
        ).run(it.quantity, it.product_id, op.location_id);
      } else if (op.operation_type === PosOperationType.DEVOLUCION) {
        db.prepare(
          'UPDATE inventory_balances SET review_stock = MAX(0, review_stock - ?) WHERE product_id = ? AND location_id = ?'
        ).run(it.quantity, it.product_id, op.location_id);
      }

      db.prepare(
        `INSERT INTO inventory_movements (
          product_id, location_id, movement_type, quantity_delta, stock_bucket,
          reference_type, reference_id, user_id, notes
        ) VALUES (?, ?, 'POS_VOID', ?, 'PHYSICAL', 'POS_OPERATION', ?, ?, ?)`
      ).run(
        it.product_id,
        op.location_id,
        it.quantity,
        String(opId),
        req.user!.id,
        `Anulación ${op.operation_number}: ${reason.trim()}`
      );

      recomputeAvailableStock(it.product_id, Number(op.location_id));
    }

    db.prepare(
      `UPDATE pos_operations SET
        status = 'ANULADA',
        voided_by_user_id = ?,
        void_reason = ?,
        updated_at = datetime('now')
       WHERE id = ?`
    ).run(req.user!.id, reason.trim(), opId);

    logAudit({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'POS_OPERATION_VOIDED',
      entityType: 'POS_OPERATION',
      entityId: opId,
      locationId: Number(op.location_id),
      oldValue: { status: op.status },
      newValue: { status: 'ANULADA', reason: reason.trim() },
      ipAddress: getClientIp(req),
    });
  });

  tx();
  res.json({ ok: true });
});

app.get('/api/pos/export-erp', requireAuth, requireRole(UserRole.JEFE_STOCK), (_req, res) => {
  const rows = db
    .prepare(
      `SELECT po.operation_number as "Nro Operación", po.operation_type as "Tipo",
        po.status as "Estado", l.code as "Cód. Ubicación", l.name as "Ubicación",
        p.sku as "Código Artículo", p.description as "Descripción",
        poi.quantity as "Cantidad", poi.unit_price as "Precio Unitario",
        poi.line_total as "Subtotal", po.customer_name as "Cliente",
        po.created_at as "Fecha Operación", po.erp_sync_status as "Estado ERP"
       FROM pos_operations po
       JOIN pos_operation_items poi ON poi.operation_id = po.id
       JOIN products p ON p.id = poi.product_id
       JOIN locations l ON l.id = po.location_id
       ORDER BY po.created_at DESC`
    )
    .all();

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Movimientos_POS_ERP');
  const buf = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="Movimientos_POS_Para_ERP.xlsx"');
  res.send(buf);
});

// ============================================================================
// 9. EXECUTIVE DASHBOARD, AI ANALYTICS, NOTIFICATIONS, AUDIT & BACKUP
// ============================================================================

app.get('/api/dashboard/executive', requireAuth, requireRole(UserRole.JEFE_STOCK), (req: AuthenticatedRequest, res) => {
  const dateFrom = String(req.query.dateFrom || '').trim();
  const dateTo = String(req.query.dateTo || '').trim();
  const locationId = req.query.locationId ? Number(req.query.locationId) : null;
  const counterId = req.query.counterId ? Number(req.query.counterId) : null;
  const skuFilter = String(req.query.sku || '').trim();

  const countConds: string[] = [];
  const countParams: unknown[] = [];

  if (dateFrom) {
    countConds.push('c.scheduled_date >= ?');
    countParams.push(dateFrom);
  }
  if (dateTo) {
    countConds.push('c.scheduled_date <= ?');
    countParams.push(dateTo);
  }
  if (locationId) {
    countConds.push('c.location_id = ?');
    countParams.push(locationId);
  }
  if (counterId) {
    countConds.push('c.assigned_counter_id = ?');
    countParams.push(counterId);
  }

  const countWhere = countConds.length > 0 ? `WHERE ${countConds.join(' AND ')}` : '';

  const totalProducts = (db.prepare('SELECT COUNT(*) as c FROM products').get() as { c: number }).c;
  const totalLocations = (
    db.prepare('SELECT COUNT(*) as c FROM locations WHERE is_active = 1').get() as { c: number }
  ).c;

  const countStats = db
    .prepare(
      `SELECT
        COUNT(*) as total_counts,
        SUM(CASE WHEN c.status = 'PROGRAMADO' THEN 1 ELSE 0 END) as programados,
        SUM(CASE WHEN c.status = 'EN_PROGRESO' THEN 1 ELSE 0 END) as en_progreso,
        SUM(CASE WHEN c.status IN ('ENVIADO_REVISION', 'RECONTEO_SOLICITADO') THEN 1 ELSE 0 END) as en_revision,
        SUM(CASE WHEN c.status = 'VALIDADO' THEN 1 ELSE 0 END) as validados,
        SUM(CASE WHEN c.status = 'CERRADO' THEN 1 ELSE 0 END) as cerrados
       FROM counts c ${countWhere}`
    )
    .get(...countParams) as Record<string, number>;

  const itemConds = [...countConds];
  const itemParams = [...countParams];
  if (skuFilter) {
    itemConds.push('p.sku LIKE ?');
    itemParams.push(`%${skuFilter}%`);
  }
  const itemWhere = itemConds.length > 0 ? `WHERE ${itemConds.join(' AND ')}` : '';

  const discrepancyStats = db
    .prepare(
      `SELECT
        COUNT(*) as total_counted_lines,
        SUM(CASE WHEN ci.reconciliation_result = 'COINCIDENCIA' THEN 1 ELSE 0 END) as coincidencias,
        SUM(CASE WHEN ci.reconciliation_result = 'FALTANTE' THEN 1 ELSE 0 END) as faltantes,
        SUM(CASE WHEN ci.reconciliation_result = 'SOBRANTE' THEN 1 ELSE 0 END) as sobrantes,
        SUM(CASE WHEN ci.reconciliation_result = 'FALTANTE' THEN ABS(ci.difference) ELSE 0 END) as faltantes_units,
        SUM(CASE WHEN ci.reconciliation_result = 'SOBRANTE' THEN ci.difference ELSE 0 END) as sobrantes_units,
        SUM(CASE WHEN ci.reconciliation_result IN ('FALTANTE', 'SOBRANTE') AND ci.snapshot_cost_price IS NOT NULL
          THEN ci.difference * ci.snapshot_cost_price ELSE 0 END) as net_economic_diff,
        SUM(CASE WHEN ci.reconciliation_result IN ('FALTANTE', 'SOBRANTE') AND ci.snapshot_cost_price IS NOT NULL
          THEN ABS(ci.difference) * ci.snapshot_cost_price ELSE 0 END) as abs_economic_diff,
        SUM(CASE WHEN ci.recount_qty IS NOT NULL THEN 1 ELSE 0 END) as recounts_lines
       FROM count_items ci
       JOIN counts c ON c.id = ci.count_id
       JOIN products p ON p.id = ci.product_id
       ${itemWhere}`
    )
    .get(...itemParams) as Record<string, number>;

  const recurringProducts = db
    .prepare(
      `SELECT p.sku, p.description, l.name as location_name,
        COUNT(*) as discrepancy_events,
        SUM(ci.difference) as cumulative_diff
       FROM count_items ci
       JOIN counts c ON c.id = ci.count_id
       JOIN products p ON p.id = ci.product_id
       JOIN locations l ON l.id = c.location_id
       WHERE ci.reconciliation_result IN ('FALTANTE', 'SOBRANTE')
       GROUP BY p.id, l.id
       ORDER BY discrepancy_events DESC, ABS(cumulative_diff) DESC
       LIMIT 10`
    )
    .all();

  const locationReliability = db
    .prepare(
      `SELECT l.id, l.name, l.group_type,
        COUNT(DISTINCT c.id) as counts_total,
        SUM(CASE WHEN ci.reconciliation_result = 'COINCIDENCIA' THEN 1 ELSE 0 END) as matches,
        SUM(CASE WHEN ci.reconciliation_result IN ('FALTANTE', 'SOBRANTE') THEN 1 ELSE 0 END) as discrepancies
       FROM locations l
       LEFT JOIN counts c ON c.location_id = l.id
       LEFT JOIN count_items ci ON ci.count_id = c.id
       WHERE l.is_active = 1
       GROUP BY l.id
       ORDER BY discrepancies DESC, l.id ASC`
    )
    .all();

  const counterProductivity = db
    .prepare(
      `SELECT u.id, u.full_name,
        COUNT(DISTINCT c.id) as total_counts,
        SUM(CASE WHEN c.status IN ('ENVIADO_REVISION', 'VALIDADO', 'CERRADO') THEN 1 ELSE 0 END) as completed_counts,
        (SELECT COUNT(*) FROM count_items ci2 JOIN counts c2 ON c2.id = ci2.count_id
         WHERE c2.assigned_counter_id = u.id AND ci2.final_counted_qty IS NOT NULL) as total_items_counted,
        (SELECT COUNT(*) FROM count_items ci3 JOIN counts c3 ON c3.id = ci3.count_id
         WHERE c3.assigned_counter_id = u.id AND ci3.recount_qty IS NOT NULL) as recount_items,
        ROUND(AVG(CASE WHEN c.submitted_at IS NOT NULL AND c.blind_printed_at IS NOT NULL
          THEN (julianday(c.submitted_at) - julianday(c.blind_printed_at)) * 24.0 ELSE NULL END), 1) as avg_hours_execution
       FROM users u
       LEFT JOIN counts c ON c.assigned_counter_id = u.id
       WHERE u.role = 'CONTADOR' AND u.is_active = 1
       GROUP BY u.id`
    )
    .all();

  const trendSeries = db
    .prepare(
      `SELECT c.scheduled_date as date,
        COUNT(ci.id) as total_lines,
        SUM(CASE WHEN ci.reconciliation_result = 'COINCIDENCIA' THEN 1 ELSE 0 END) as matches,
        SUM(CASE WHEN ci.reconciliation_result IN ('FALTANTE', 'SOBRANTE') THEN 1 ELSE 0 END) as discrepancies
       FROM counts c
       JOIN count_items ci ON ci.count_id = c.id
       WHERE ci.reconciliation_result IS NOT NULL
       GROUP BY c.scheduled_date
       ORDER BY c.scheduled_date ASC
       LIMIT 30`
    )
    .all();

  const adjConds: string[] = [
    "im.movement_type IN ('ERP_ADJUSTMENT', 'ERP_MOVEMENT')",
    "date(im.created_at) >= date('now', '-29 days')",
  ];
  const adjParams: unknown[] = [];
  if (locationId) {
    adjConds.push('im.location_id = ?');
    adjParams.push(locationId);
  }
  if (skuFilter) {
    adjConds.push('p.sku LIKE ?');
    adjParams.push(`%${skuFilter}%`);
  }

  const adjRows = db
    .prepare(
      `SELECT date(im.created_at) as date,
        COALESCE(SUM(ABS(im.quantity_delta)), 0) as adjusted_abs_units,
        COALESCE(SUM(im.quantity_delta), 0) as adjusted_net_units,
        COALESCE(SUM(CASE WHEN im.quantity_delta > 0 THEN im.quantity_delta ELSE 0 END), 0) as positive_units,
        COALESCE(SUM(CASE WHEN im.quantity_delta < 0 THEN ABS(im.quantity_delta) ELSE 0 END), 0) as negative_units,
        COUNT(im.id) as adjustment_events
       FROM inventory_movements im
       JOIN products p ON p.id = im.product_id
       WHERE ${adjConds.join(' AND ')}
       GROUP BY date(im.created_at)
       ORDER BY date ASC`
    )
    .all(...adjParams) as Array<{
    date: string;
    adjusted_abs_units: number;
    adjusted_net_units: number;
    positive_units: number;
    negative_units: number;
    adjustment_events: number;
  }>;

  const adjByDate = new Map(adjRows.map((r) => [r.date, r]));
  const adjustedVolumeSeries: Array<{
    date: string;
    adjusted_abs_units: number;
    adjusted_net_units: number;
    positive_units: number;
    negative_units: number;
    adjustment_events: number;
  }> = [];

  const todayUtc = new Date();
  for (let offset = 29; offset >= 0; offset--) {
    const d = new Date(
      Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate() - offset)
    );
    const iso = d.toISOString().slice(0, 10);
    const row = adjByDate.get(iso);
    adjustedVolumeSeries.push({
      date: iso,
      adjusted_abs_units: row ? Math.round(Number(row.adjusted_abs_units) * 100) / 100 : 0,
      adjusted_net_units: row ? Math.round(Number(row.adjusted_net_units) * 100) / 100 : 0,
      positive_units: row ? Math.round(Number(row.positive_units) * 100) / 100 : 0,
      negative_units: row ? Math.round(Number(row.negative_units) * 100) / 100 : 0,
      adjustment_events: row ? Number(row.adjustment_events) : 0,
    });
  }

  const liveCounts = db
    .prepare(
      `SELECT
        SUM(CASE WHEN status IN ('PROGRAMADO', 'EN_PROGRESO', 'RECONTEO_SOLICITADO') THEN 1 ELSE 0 END) as active_counts,
        SUM(CASE WHEN status = 'PROGRAMADO' THEN 1 ELSE 0 END) as programados,
        SUM(CASE WHEN status = 'EN_PROGRESO' THEN 1 ELSE 0 END) as en_progreso,
        SUM(CASE WHEN status = 'RECONTEO_SOLICITADO' THEN 1 ELSE 0 END) as reconteos,
        SUM(CASE WHEN status = 'ENVIADO_REVISION' THEN 1 ELSE 0 END) as pending_validations,
        SUM(CASE WHEN status = 'VALIDADO' THEN 1 ELSE 0 END) as awaiting_closure
       FROM counts`
    )
    .get() as Record<string, number>;

  const activeStockUnits = (
    db.prepare('SELECT COALESCE(SUM(available_stock), 0) as units FROM inventory_balances').get() as {
      units: number;
    }
  ).units;

  const userDailySales = db
    .prepare(
      `SELECT
        COUNT(DISTINCT po.id) as sales_count,
        COALESCE(SUM(po.total), 0) as sales_total,
        COALESCE((
          SELECT SUM(poi.quantity)
          FROM pos_operation_items poi
          JOIN pos_operations po2 ON po2.id = poi.operation_id
          WHERE po2.created_by_user_id = ?
            AND po2.operation_type = 'VENTA'
            AND po2.status = 'CONFIRMADA'
            AND date(po2.created_at) = date('now')
        ), 0) as sales_units
       FROM pos_operations po
       WHERE po.created_by_user_id = ?
         AND po.operation_type = 'VENTA'
         AND po.status = 'CONFIRMADA'
         AND date(po.created_at) = date('now')`
    )
    .get(req.user!.id, req.user!.id) as {
    sales_count: number;
    sales_total: number;
    sales_units: number;
  };

  const teamDailySales = db
    .prepare(
      `SELECT COALESCE(SUM(total), 0) as sales_total, COUNT(*) as sales_count
       FROM pos_operations
       WHERE operation_type = 'VENTA'
         AND status = 'CONFIRMADA'
         AND date(created_at) = date('now')`
    )
    .get() as { sales_total: number; sales_count: number };

  res.json({
    quickMetrics: {
      activeInventoryCounts: Number(liveCounts.active_counts || 0),
      programados: Number(liveCounts.programados || 0),
      enProgreso: Number(liveCounts.en_progreso || 0),
      reconteos: Number(liveCounts.reconteos || 0),
      activeStockUnits: Number(activeStockUnits || 0),
      pendingValidations: Number(liveCounts.pending_validations || 0),
      awaitingClosure: Number(liveCounts.awaiting_closure || 0),
      userDailySalesAmount: Number(userDailySales.sales_total || 0),
      userDailySalesCount: Number(userDailySales.sales_count || 0),
      userDailySalesUnits: Number(userDailySales.sales_units || 0),
      teamDailySalesAmount: Number(teamDailySales.sales_total || 0),
      teamDailySalesCount: Number(teamDailySales.sales_count || 0),
    },
    general: {
      totalProducts,
      totalLocations,
      ...countStats,
      compliancePct:
        countStats.total_counts > 0
          ? Math.round(
              (((countStats.validados || 0) + (countStats.cerrados || 0) + (countStats.en_revision || 0)) /
                countStats.total_counts) *
                1000
            ) / 10
          : 0,
    },
    discrepancies: {
      ...discrepancyStats,
      matchRatePct:
        discrepancyStats.total_counted_lines > 0
          ? Math.round(
              ((discrepancyStats.coincidencias || 0) / discrepancyStats.total_counted_lines) * 1000
            ) / 10
          : null,
      recountRatePct:
        discrepancyStats.total_counted_lines > 0
          ? Math.round(
              ((discrepancyStats.recounts_lines || 0) / discrepancyStats.total_counted_lines) * 1000
            ) / 10
          : 0,
    },
    recurringProducts,
    locationReliability,
    counterProductivity,
    trendSeries,
    adjustedVolumeSeries,
  });
});

app.post('/api/ai/executive-report', requireAuth, requireRole(UserRole.JEFE_STOCK), async (req, res) => {
  try {
    const locationId = req.body?.locationId ? Number(req.body.locationId) : undefined;
    const report = await generateExecutiveAiAnalysis(locationId);
    res.json({ report });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.get('/api/notifications', requireAuth, (req: AuthenticatedRequest, res) => {
  const rows = db
    .prepare(
      `SELECT * FROM notifications
       WHERE target_user_id = ? OR target_role = ? OR (target_user_id IS NULL AND target_role IS NULL)
       ORDER BY is_read ASC, created_at DESC LIMIT 40`
    )
    .all(req.user!.id, req.user!.role);
  res.json({ notifications: rows });
});

app.post('/api/notifications/:id/read', requireAuth, (req: AuthenticatedRequest, res) => {
  db.prepare(
    'UPDATE notifications SET is_read = 1 WHERE id = ? AND (target_user_id = ? OR target_role = ?)'
  ).run(Number(req.params.id), req.user!.id, req.user!.role);
  res.json({ ok: true });
});

app.post('/api/notifications/read-all', requireAuth, (req: AuthenticatedRequest, res) => {
  db.prepare(
    'UPDATE notifications SET is_read = 1 WHERE target_user_id = ? OR target_role = ?'
  ).run(req.user!.id, req.user!.role);
  res.json({ ok: true });
});

app.get('/api/audit', requireAuth, requireRole(UserRole.JEFE_STOCK), (req, res) => {
  const action = String(req.query.action || '').trim();
  const username = String(req.query.username || '').trim();
  const conds: string[] = [];
  const params: unknown[] = [];
  if (action) {
    conds.push('action LIKE ?');
    params.push(`%${action}%`);
  }
  if (username) {
    conds.push('username LIKE ?');
    params.push(`%${username}%`);
  }
  const whereSql = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const events = db
    .prepare(`SELECT * FROM audit_events ${whereSql} ORDER BY id DESC LIMIT 250`)
    .all(...params);
  res.json({ events });
});

app.get('/api/admin/backup', requireAuth, requireRole(UserRole.JEFE_STOCK), (req: AuthenticatedRequest, res) => {
  const tables = [
    'locations',
    'users',
    'import_batches',
    'products',
    'inventory_balances',
    'inventory_movements',
    'risk_config',
    'count_goals',
    'counts',
    'count_items',
    'pos_operations',
    'pos_operation_items',
    'audit_events',
  ];

  const dump: Record<string, unknown> = {
    exportedAt: new Date().toISOString(),
    exportedBy: req.user!.username,
    tables: {},
  };

  for (const t of tables) {
    if (t === 'users') {
      (dump.tables as Record<string, unknown>)[t] = db
        .prepare(
          'SELECT id, username, full_name, email, role, assigned_location_ids, is_active, last_login_at, created_at FROM users'
        )
        .all();
    } else {
      (dump.tables as Record<string, unknown>)[t] = db.prepare(`SELECT * FROM ${t}`).all();
    }
  }

  logAudit({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'DATABASE_BACKUP_EXPORTED',
    entityType: 'SYSTEM',
    ipAddress: getClientIp(req),
  });

  res.setHeader('Content-Type', 'application/json');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="SICEP_Respaldo_${new Date().toISOString().slice(0, 10)}.json"`
  );
  res.send(JSON.stringify(dump, null, 2));
});

// ============================================================================
// VITE DEV MIDDLEWARE / PRODUCTION STATIC SERVING
// ============================================================================

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SICEP Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
