import Database from 'better-sqlite3';
import crypto from 'crypto';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import multer from 'multer';
import os from 'os';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import * as XLSX from 'xlsx';
import { generateExecutiveAiAnalysis } from './src/server/aiService.ts';
import {
  createNotification,
  DATA_ROOT_DIR,
  db,
  DB_PATH,
  getStorageDiagnostics,
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
  type AuthenticatedRequest,
  createSessionToken,
  hashPassword,
  mapDbUser,
  parsePositiveInt,
  requireAuth,
  requireRole,
  revokeUserTokens,
  userCanAccessLocation,
  validateSecurityConfig,
  verifyPassword,
} from './src/server/security.ts';
import {
  AdjustmentOperationType,
  type AuthUser,
  CountStatus,
  type ExcelColumnMapping,
  LocationGroup,
  ReconciliationResult,
  type RiskThresholds,
  type RiskWeights,
  UserRole,
} from './src/types/erp.ts';

dotenv.config();
validateSecurityConfig();
initDatabase();

const storageDiag = getStorageDiagnostics();
if (process.env.NODE_ENV === 'production' && !storageDiag.isVerifiedPersistent) {
  console.warn(
    `[SICEP ADVERTENCIA PERSISTENCIA] El directorio de datos (${storageDiag.dataDir}) reside sobre filesystem "${
      storageDiag.mountFilesystemType || 'desconocido'
    }" (${storageDiag.mountPoint || 'N/A'}). Configure SICEP_DATA_DIR sobre un volumen persistente para evitar pérdida de datos en redeploys.`
  );
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use((req, res, next) => {
  if (req.path === '/api/admin/restore' || req.path === '/api/admin/backup/verify') {
    express.json({ limit: '60mb' })(req, res, next);
    return;
  }
  express.json({ limit: '15mb' })(req, res, next);
});

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const ALLOWED_ATTACHMENT_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'text/plain',
]);
const BLOCKED_ATTACHMENT_EXTS = new Set(['.html', '.htm', '.svg', '.js', '.mjs', '.cjs', '.xml', '.xhtml']);

const diskUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10);
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (BLOCKED_ATTACHMENT_EXTS.has(ext) || !ALLOWED_ATTACHMENT_MIMES.has(file.mimetype)) {
      cb(new Error('Tipo de archivo no permitido. Use imágenes (JPG/PNG/WEBP), PDF, Excel o CSV.'));
      return;
    }
    cb(null, true);
  },
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

// In-memory login brute-force rate limiter (10 failed attempts / 15 min per IP + username)
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map<string, { count: number; windowStart: number }>();

function getLoginAttemptKey(ip: string, username: string): string {
  return `${ip || 'unknown'}::${username.trim().toLowerCase()}`;
}

function isLoginRateLimited(key: string): { limited: boolean; retryAfterSec: number } {
  const rec = loginFailures.get(key);
  if (!rec) return { limited: false, retryAfterSec: 0 };
  const elapsed = Date.now() - rec.windowStart;
  if (elapsed > LOGIN_RATE_WINDOW_MS) {
    loginFailures.delete(key);
    return { limited: false, retryAfterSec: 0 };
  }
  if (rec.count >= LOGIN_MAX_FAILURES) {
    return {
      limited: true,
      retryAfterSec: Math.max(1, Math.ceil((LOGIN_RATE_WINDOW_MS - elapsed) / 1000)),
    };
  }
  return { limited: false, retryAfterSec: 0 };
}

function recordLoginFailure(key: string): void {
  const now = Date.now();
  const rec = loginFailures.get(key);
  if (!rec || now - rec.windowStart > LOGIN_RATE_WINDOW_MS) {
    loginFailures.set(key, { count: 1, windowStart: now });
  } else {
    rec.count += 1;
  }
}

app.get('/api/auth/status', (_req, res) => {
  const adminCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'JEFE_STOCK'").get() as {
      cnt: number;
    }
  ).cnt;
  res.json({ needsBootstrap: adminCount === 0 });
});

app.post('/api/auth/bootstrap', (req, res) => {
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

  const bootstrapTx = db.transaction(() => {
    const adminCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'JEFE_STOCK'").get() as {
        cnt: number;
      }
    ).cnt;

    if (adminCount > 0) {
      return null;
    }

    const info = db
      .prepare(
        `INSERT INTO users (username, full_name, email, role, password_hash, assigned_location_ids, assigned_families, token_version, password_changed_at, is_active, last_login_at)
         VALUES (?, ?, ?, 'JEFE_STOCK', ?, '[]', '[]', 1, datetime('now'), 1, datetime('now'))`
      )
      .run(cleanUser, fullName.trim(), (email || '').trim(), pwHash);

    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid) as Record<
      string,
      unknown
    >;
    const authUser = mapDbUser(userRow);
    const token = createSessionToken(authUser, Number(userRow.token_version ?? 1));

    logAudit({
      userId: authUser.id,
      username: authUser.username,
      action: 'SYSTEM_BOOTSTRAP_ADMIN',
      entityType: 'USER',
      entityId: authUser.id,
      newValue: { username: authUser.username, role: authUser.role },
      ipAddress: getClientIp(req),
    });

    return { token, user: authUser };
  });

  const created = bootstrapTx.immediate();
  if (!created) {
    res.status(409).json({
      error: 'El sistema ya fue inicializado. Inicie sesión con sus credenciales.',
    });
    return;
  }

  res.status(201).json(created);
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ error: 'Ingrese usuario y contraseña.' });
    return;
  }

  const clientIp = getClientIp(req);
  const cleanUser = username.trim().toLowerCase();
  const rateKey = getLoginAttemptKey(clientIp, cleanUser);
  const rateCheck = isLoginRateLimited(rateKey);
  if (rateCheck.limited) {
    res.setHeader('Retry-After', String(rateCheck.retryAfterSec));
    res.status(429).json({
      error: `Demasiados intentos fallidos. Intente nuevamente en ${Math.ceil(rateCheck.retryAfterSec / 60)} minuto(s).`,
    });
    return;
  }

  const row = db
    .prepare('SELECT * FROM users WHERE LOWER(username) = ?')
    .get(cleanUser) as Record<string, unknown> | undefined;

  if (!row || !verifyPassword(password, String(row.password_hash))) {
    recordLoginFailure(rateKey);
    logAudit({
      username: cleanUser,
      action: 'LOGIN_FAILED',
      entityType: 'AUTH',
      newValue: { username: cleanUser },
      ipAddress: clientIp,
    });
    res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    return;
  }

  if (!row.is_active) {
    res.status(403).json({ error: 'La cuenta se encuentra deshabilitada. Contacte al Jefe de Control de Stock.' });
    return;
  }

  loginFailures.delete(rateKey);
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(row.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id) as Record<
    string,
    unknown
  >;
  const user = mapDbUser(updated);
  const token = createSessionToken(user, Number(updated.token_version ?? 1));

  logAudit({
    userId: user.id,
    username: user.username,
    action: 'USER_LOGIN',
    entityType: 'AUTH',
    entityId: user.id,
    ipAddress: clientIp,
  });

  res.json({ token, user });
});

app.post('/api/auth/logout', requireAuth, (req: AuthenticatedRequest, res) => {
  revokeUserTokens(req.user!.id);
  logAudit({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'USER_LOGOUT',
    entityType: 'AUTH',
    entityId: req.user!.id,
    ipAddress: getClientIp(req),
  });
  res.json({ ok: true });
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

  const validLocationIds = new Set(
    (db.prepare('SELECT id FROM locations').all() as Array<{ id: number }>).map((l) => l.id)
  );
  const locs =
    role === UserRole.AUDITORIA_DIRECCION || role === UserRole.JEFE_STOCK
      ? []
      : Array.isArray(assignedLocationIds)
        ? Array.from(new Set(assignedLocationIds.map(Number).filter((id) => validLocationIds.has(id))))
        : [];
  const fams =
    role === UserRole.CONTADOR && Array.isArray(assignedFamilies)
      ? Array.from(new Set(assignedFamilies.map((f) => String(f).trim()).filter(Boolean)))
      : [];
  const pwHash = hashPassword(password);
  const info = db
    .prepare(
      `INSERT INTO users (username, full_name, email, role, password_hash, assigned_location_ids, assigned_families, token_version, password_changed_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), 1)`
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
  const targetId = parsePositiveInt(req.params.id);
  if (!targetId) {
    res.status(400).json({ error: 'Identificador de usuario inválido.' });
    return;
  }
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
  if (targetId === req.user!.id && role && role !== UserRole.JEFE_STOCK) {
    res.status(400).json({ error: 'No puede degradar el rol de su propia cuenta administradora activa.' });
    return;
  }

  const validLocationIds = new Set(
    (db.prepare('SELECT id FROM locations').all() as Array<{ id: number }>).map((l) => l.id)
  );
  const nextRole = role && Object.values(UserRole).includes(role) ? role : (oldRow.role as UserRole);
  const nextLocs =
    nextRole === UserRole.AUDITORIA_DIRECCION || nextRole === UserRole.JEFE_STOCK
      ? '[]'
      : Array.isArray(assignedLocationIds)
        ? JSON.stringify(
            Array.from(new Set(assignedLocationIds.map(Number).filter((id) => validLocationIds.has(id))))
          )
        : String(oldRow.assigned_location_ids || '[]');
  const nextFams =
    nextRole !== UserRole.CONTADOR
      ? '[]'
      : Array.isArray(assignedFamilies)
        ? JSON.stringify(
            Array.from(new Set(assignedFamilies.map((f) => String(f).trim()).filter(Boolean)))
          )
        : String(oldRow.assigned_families || '[]');
  const nextActive = typeof isActive === 'boolean' ? (isActive ? 1 : 0) : Number(oldRow.is_active);

  const permissionsChanged =
    nextRole !== oldRow.role ||
    nextLocs !== String(oldRow.assigned_location_ids || '[]') ||
    nextFams !== String(oldRow.assigned_families || '[]') ||
    nextActive !== Number(oldRow.is_active);

  db.prepare(
    `UPDATE users SET
      full_name = ?,
      email = ?,
      role = ?,
      assigned_location_ids = ?,
      assigned_families = ?,
      is_active = ?,
      token_version = CASE WHEN ? THEN COALESCE(token_version, 1) + 1 ELSE COALESCE(token_version, 1) END,
      updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    fullName ? fullName.trim() : String(oldRow.full_name),
    email !== undefined ? email.trim() : String(oldRow.email || ''),
    nextRole,
    nextLocs,
    nextFams,
    nextActive,
    permissionsChanged ? 1 : 0,
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
    const targetId = parsePositiveInt(req.params.id);
    if (!targetId) {
      res.status(400).json({ error: 'Identificador de usuario inválido.' });
      return;
    }
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

    db.prepare(
      `UPDATE users SET
        password_hash = ?,
        token_version = COALESCE(token_version, 1) + 1,
        password_changed_at = datetime('now'),
        updated_at = datetime('now')
       WHERE id = ?`
    ).run(hashPassword(newPassword), targetId);

    logAudit({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'USER_PASSWORD_RESET',
      entityType: 'USER',
      entityId: targetId,
      newValue: { username: oldRow.username, resetBy: req.user!.username, sessionsRevoked: true },
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
        (SELECT COUNT(*) FROM counts c WHERE c.location_id = l.id AND c.status IN ('EJECUCION','ENTREGADO','RECHAZADO')) as open_counts,
        (SELECT COUNT(*) FROM count_items ci JOIN counts c ON c.id = ci.count_id WHERE c.location_id = l.id AND ci.reconciliation_result IN ('FALTANTE','SOBRANTE')) as total_discrepancies,
        (SELECT COUNT(*) FROM count_items ci JOIN counts c ON c.id = ci.count_id WHERE c.location_id = l.id AND ci.reconciliation_result = 'COINCIDENCIA') as total_matches
      FROM locations l
      LEFT JOIN users u ON u.id = l.manager_user_id
      ORDER BY l.id ASC
    `
    )
    .all() as Array<Record<string, unknown>>;

  const filtered =
    req.user!.role === UserRole.JEFE_STOCK || req.user!.role === UserRole.AUDITORIA_DIRECCION
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
              p.cost_price, ib.erp_physical_stock, ib.committed_stock,
              ib.review_stock, ib.damaged_stock, ib.available_stock,
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

  if (req.user!.role !== UserRole.JEFE_STOCK && req.user!.role !== UserRole.AUDITORIA_DIRECCION) {
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
        p.criticality_level,
        p.last_erp_sync_at,
        ib.location_id,
        l.name as location_name,
        l.code as location_code,
        ib.erp_physical_stock,
        ib.committed_stock,
        ib.review_stock,
        ib.damaged_stock,
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
  let consolidatedBalanceJoin = 'LEFT JOIN inventory_balances ib ON ib.product_id = p.id';

  if (req.user!.role !== UserRole.JEFE_STOCK && req.user!.role !== UserRole.AUDITORIA_DIRECCION) {
    const locPlaceholders = req.user!.assignedLocationIds.map(() => '?').join(',');
    consolidatedBalanceJoin = `LEFT JOIN inventory_balances ib ON ib.product_id = p.id AND ib.location_id IN (${locPlaceholders})`;
    consolidatedParams.push(...req.user!.assignedLocationIds);
  }
  if (locationId) {
    consolidatedBalanceJoin += ' AND ib.location_id = ?';
    consolidatedParams.push(locationId);
  }

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
        p.criticality_level,
        p.last_erp_sync_at,
        COUNT(DISTINCT ib.location_id) as locations_count,
        COALESCE(SUM(ib.erp_physical_stock), 0) as total_erp_physical,
        COALESCE(SUM(ib.committed_stock), 0) as total_committed,
        COALESCE(SUM(ib.review_stock), 0) as total_review,
        COALESCE(SUM(ib.damaged_stock), 0) as total_damaged,
        COALESCE(SUM(ib.available_stock), 0) as total_available
      FROM products p
      ${consolidatedBalanceJoin}
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

app.get(
  '/api/inventory/batches',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK, UserRole.AUDITORIA_DIRECCION),
  (_req, res) => {
  const batches = db
    .prepare(
      `SELECT ib.*, COALESCE(u.full_name, 'Usuario eliminado') as uploaded_by_name
       FROM import_batches ib
       LEFT JOIN users u ON u.id = ib.uploaded_by_user_id
       ORDER BY ib.created_at DESC LIMIT 50`
    )
    .all();
  res.json({ batches });
});

app.delete(
  '/api/inventory/batches/:id',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK),
  (req: AuthenticatedRequest, res) => {
    const batchId = parsePositiveInt(req.params.id);
    if (!batchId) {
      res.status(400).json({ error: 'Identificador de lote inválido.' });
      return;
    }

    try {
      const batch = db
        .prepare('SELECT * FROM import_batches WHERE id = ?')
        .get(batchId) as Record<string, unknown> | undefined;

      if (!batch) {
        res.status(404).json({ error: 'Lote de importación no encontrado.' });
        return;
      }

      const deleteTx = db.transaction(() => {
        // Solo elimina la cabecera del lote; inventory_balances.last_import_batch_id queda en NULL (ON DELETE SET NULL)
        db.prepare('DELETE FROM import_batches WHERE id = ?').run(batchId);

        logAudit({
          userId: req.user!.id,
          username: req.user!.username,
          action: 'ERP_IMPORT_BATCH_DELETED',
          entityType: 'IMPORT_BATCH',
          entityId: batchId,
          oldValue: {
            filename: batch.filename,
            cutoffTimestamp: batch.cutoff_timestamp,
            totalRows: batch.total_rows,
            insertedProducts: batch.inserted_products,
            updatedBalances: batch.updated_balances,
            createdAt: batch.created_at,
          },
          ipAddress: getClientIp(req),
        });
      });

      deleteTx();
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({
        error: (err as Error).message || 'Error interno al eliminar el lote de importación.',
      });
    }
  }
);

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

app.get(
  '/api/inventory/export',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK, UserRole.AUDITORIA_DIRECCION),
  (_req, res) => {
  const rows = db
    .prepare(
      `SELECT p.sku as "Código", p.description as "Descripción", p.alias as "Alias",
        p.family as "Familia", p.brand as "Marca", p.unit_of_measure as "UM",
        COALESCE(l.name, 'Almacén Maestro (Global)') as "Ubicación",
        COALESCE(ib.erp_physical_stock, 0) as "Existencia ERP",
        COALESCE(ib.committed_stock, 0) as "Comprometido",
        COALESCE(ib.review_stock, 0) as "En Revisión",
        COALESCE(ib.damaged_stock, 0) as "Rotura",
        COALESCE(ib.available_stock, 0) as "Disponible",
        p.cost_price as "Costo",
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

app.get('/api/goals', requireAuth, (req: AuthenticatedRequest, res) => {
  const conds: string[] = [];
  const params: unknown[] = [];

  if (req.user!.role !== UserRole.JEFE_STOCK && req.user!.role !== UserRole.AUDITORIA_DIRECCION) {
    if (req.user!.assignedLocationIds.length > 0) {
      const ph = req.user!.assignedLocationIds.map(() => '?').join(',');
      conds.push(`(g.assigned_counter_id = ? OR g.location_id IN (${ph}))`);
      params.push(req.user!.id, ...req.user!.assignedLocationIds);
    } else {
      conds.push('g.assigned_counter_id = ?');
      params.push(req.user!.id);
    }
  }

  const whereSql = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const goals = db
    .prepare(
      `SELECT g.*, l.name as location_name, u.full_name as counter_name
       FROM count_goals g
       LEFT JOIN locations l ON l.id = g.location_id
       LEFT JOIN users u ON u.id = g.assigned_counter_id
       ${whereSql}
       ORDER BY g.target_date DESC, g.id DESC LIMIT 40`
    )
    .all(...params);
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

  if (locationId && req.user!.role !== UserRole.JEFE_STOCK && req.user!.role !== UserRole.AUDITORIA_DIRECCION) {
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

  if (
    req.user!.role !== UserRole.JEFE_STOCK &&
    req.user!.role !== UserRole.AUDITORIA_DIRECCION &&
    req.user!.assignedLocationIds.length === 0 &&
    !locationId
  ) {
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

app.post(
  '/api/blind-sheet/log-print',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK, UserRole.CONTADOR, UserRole.RESPONSABLE_DEPOSITO),
  (req: AuthenticatedRequest, res) => {
  const { documentUid, locationId, family, rubro, itemsCount, countNumber } = req.body as {
    documentUid?: string;
    locationId?: number;
    family?: string;
    rubro?: string;
    itemsCount?: number;
    countNumber?: string;
  };

  let verifiedLocationId: number | null = null;
  if (locationId !== undefined && locationId !== null) {
    const locIdNum = parsePositiveInt(locationId);
    if (!locIdNum) {
      res.status(400).json({ error: 'Ubicación inválida.' });
      return;
    }
    if (req.user!.role !== UserRole.JEFE_STOCK) {
      const hasCountInLoc =
        req.user!.role === UserRole.CONTADOR &&
        Boolean(
          db
            .prepare('SELECT 1 FROM counts WHERE location_id = ? AND assigned_counter_id = ? LIMIT 1')
            .get(locIdNum, req.user!.id)
        );
      if (!userCanAccessLocation(req.user!, locIdNum) && !hasCountInLoc) {
        res.status(403).json({ error: 'No tiene permisos sobre la ubicación seleccionada.' });
        return;
      }
    }
    verifiedLocationId = locIdNum;
  } else if (req.user!.role !== UserRole.JEFE_STOCK && req.user!.assignedLocationIds.length === 0) {
    res.status(403).json({ error: 'No tiene depósitos asignados para emitir planillas ciegas.' });
    return;
  }

  logAudit({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'BLIND_SHEET_GENERATED',
    entityType: 'BLIND_SHEET',
    entityId: documentUid || '',
    locationId: verifiedLocationId,
    newValue: { documentUid, countNumber, family, rubro, itemsCount },
    ipAddress: getClientIp(req),
  });

  res.json({ ok: true });
});

app.get('/api/blind-sheet/counters', requireAuth, (req: AuthenticatedRequest, res) => {
  const locationId = req.query.locationId ? parsePositiveInt(req.query.locationId) : null;

  if (req.user!.role === UserRole.CONTADOR) {
    res.json({
      counters: [
        {
          id: req.user!.id,
          fullName: req.user!.fullName,
          username: req.user!.username,
          role: req.user!.role,
          assignedLocationIds: req.user!.assignedLocationIds,
          assignedFamilies: req.user!.assignedFamilies,
        },
      ],
    });
    return;
  }

  if (
    locationId &&
    req.user!.role === UserRole.RESPONSABLE_DEPOSITO &&
    !userCanAccessLocation(req.user!, locationId)
  ) {
    res.status(403).json({ error: 'No tiene permisos sobre la ubicación seleccionada.' });
    return;
  }

  const rows = db
    .prepare(
      `SELECT * FROM users
       WHERE is_active = 1 AND role IN ('CONTADOR', 'JEFE_STOCK')
       ORDER BY CASE WHEN role = 'CONTADOR' THEN 0 ELSE 1 END, full_name ASC`
    )
    .all() as Array<Record<string, unknown>>;

  const mapped = rows.map(mapDbUser).filter((u) => {
    if (req.user!.role === UserRole.RESPONSABLE_DEPOSITO && u.role !== UserRole.CONTADOR) {
      return false;
    }
    if (locationId && u.role === UserRole.CONTADOR) {
      return userCanAccessLocation(u, locationId);
    }
    return true;
  });

  res.json({
    counters: mapped.map((u) => ({
      id: u.id,
      fullName: u.fullName,
      username: u.username,
      role: u.role,
      assignedLocationIds: u.assignedLocationIds,
      assignedFamilies: u.assignedFamilies,
    })),
  });
});

app.post(
  '/api/blind-sheet/register-count',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK, UserRole.CONTADOR, UserRole.RESPONSABLE_DEPOSITO),
  (req: AuthenticatedRequest, res) => {
  const {
    locationId,
    scheduledDate,
    countNumber,
    documentUid,
    assignedCounterId,
    productIds,
    familyLabel,
    rubroLabel,
    actionType,
  } = req.body as {
    locationId?: number;
    scheduledDate?: string;
    countNumber?: string;
    documentUid?: string;
    assignedCounterId?: number | null;
    productIds?: number[];
    familyLabel?: string;
    rubroLabel?: string;
    actionType?: 'PRINT' | 'PDF';
  };

  const locId = parsePositiveInt(locationId);
  if (!locId) {
    res.status(400).json({
      error: 'Debe seleccionar un Depósito / Ubicación específico para validar e ingresar el conteo.',
    });
    return;
  }

  if (!Array.isArray(productIds) || productIds.length === 0) {
    res.status(400).json({ error: 'Debe seleccionar al menos un artículo para registrar el conteo.' });
    return;
  }

  const uniqueProductIds = Array.from(
    new Set(productIds.map((id) => parsePositiveInt(id)).filter((id): id is number => id !== null))
  );
  if (uniqueProductIds.length === 0) {
    res.status(400).json({ error: 'Los artículos seleccionados no son válidos.' });
    return;
  }

  const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(locId) as
    | Record<string, unknown>
    | undefined;
  if (!loc) {
    res.status(404).json({ error: 'Ubicación no encontrada.' });
    return;
  }

  if (req.user!.role !== UserRole.JEFE_STOCK && !userCanAccessLocation(req.user!, locId)) {
    res.status(403).json({
      error: 'No tiene permisos para validar e ingresar conteos en la ubicación seleccionada.',
    });
    return;
  }

  const cleanDocUid = String(documentUid || '').trim().slice(0, 64);

  // Idempotency: if this blind sheet documentUid was already validated & registered, reuse it cleanly
  if (cleanDocUid) {
    const existingByUid = db
      .prepare('SELECT id, count_number, document_uid, status, location_id, assigned_counter_id FROM counts WHERE document_uid = ?')
      .get(cleanDocUid) as
      | {
          id: number;
          count_number: string;
          document_uid: string;
          status: CountStatus;
          location_id: number;
          assigned_counter_id: number | null;
        }
      | undefined;

    if (existingByUid) {
      if (
        req.user!.role === UserRole.CONTADOR &&
        Number(existingByUid.assigned_counter_id) !== req.user!.id
      ) {
        res.status(403).json({ error: 'No tiene permisos sobre esta planilla ya registrada.' });
        return;
      }
      if (
        req.user!.role === UserRole.RESPONSABLE_DEPOSITO &&
        !userCanAccessLocation(req.user!, Number(existingByUid.location_id))
      ) {
        res.status(403).json({ error: 'No tiene permisos sobre la ubicación de esta planilla.' });
        return;
      }

      db.prepare(
        `UPDATE counts SET
          blind_printed_at = COALESCE(blind_printed_at, datetime('now')),
          updated_at = datetime('now')
         WHERE id = ?`
      ).run(existingByUid.id);

      logAudit({
        userId: req.user!.id,
        username: req.user!.username,
        action: 'BLIND_SHEET_VALIDATED_REPRINTED',
        entityType: 'COUNT',
        entityId: existingByUid.id,
        locationId: Number(existingByUid.location_id),
        newValue: {
          countNumber: existingByUid.count_number,
          documentUid: existingByUid.document_uid,
          actionType: actionType || 'PRINT',
        },
        ipAddress: getClientIp(req),
      });

      res.json({
        ok: true,
        alreadyRegistered: true,
        countId: existingByUid.id,
        countNumber: existingByUid.count_number,
        documentUid: existingByUid.document_uid,
        status: existingByUid.status,
      });
      return;
    }
  }

  let resolvedCounterId: number | null = null;
  if (req.user!.role === UserRole.CONTADOR) {
    const checkSelf = validateCounterAssignmentForCount(req.user!.id, locId, uniqueProductIds);
    if (!checkSelf.ok) {
      res.status(checkSelf.status).json({ error: checkSelf.error });
      return;
    }
    resolvedCounterId = req.user!.id;
  } else if (assignedCounterId !== undefined && assignedCounterId !== null && Number(assignedCounterId) > 0) {
    const checkCounter = validateCounterAssignmentForCount(
      Number(assignedCounterId),
      locId,
      uniqueProductIds
    );
    if (!checkCounter.ok) {
      res.status(checkCounter.status).json({ error: checkCounter.error });
      return;
    }
    resolvedCounterId = Number(assignedCounterId);
  } else if (req.user!.role === UserRole.JEFE_STOCK) {
    resolvedCounterId = req.user!.id;
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const cleanDate =
    scheduledDate && /^\d{4}-\d{2}-\d{2}$/.test(scheduledDate.trim())
      ? scheduledDate.trim()
      : todayIso;

  const requestedCountNum = String(countNumber || '').trim().slice(0, 40);
  const existingNum = requestedCountNum
    ? db.prepare('SELECT id FROM counts WHERE count_number = ?').get(requestedCountNum)
    : undefined;
  const finalCountNumber =
    requestedCountNum && !existingNum
      ? requestedCountNum
      : nextSequenceNumber('CNT', 'counts', 'count_number');

  const finalDocumentUid = cleanDocUid || `BLD-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
  const actionLabel = actionType === 'PDF' ? 'Descarga PDF' : 'Impresión';
  const tagParts = [familyLabel?.trim(), rubroLabel?.trim()].filter(
    (v) => v && v !== 'Todas las familias' && v !== 'Todos los rubros'
  );
  const weeklyGoalTag =
    tagParts.length > 0 ? `Planilla Ciego (${tagParts.join(' · ')})` : 'Planilla Conteo Ciego';

  const warehouseMgrId =
    req.user!.role === UserRole.RESPONSABLE_DEPOSITO
      ? req.user!.id
      : (loc.manager_user_id as number | null) || null;

  const registerTx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO counts (
          count_number, document_uid, location_id, scheduled_date,
          assigned_counter_id, warehouse_manager_id, created_by_user_id,
          status, weekly_goal_tag, blind_printed_at, executed_at,
          started_by_user_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'EJECUCION', ?, datetime('now'), datetime('now'), ?, datetime('now'))`
      )
      .run(
        finalCountNumber,
        finalDocumentUid,
        locId,
        cleanDate,
        resolvedCounterId,
        warehouseMgrId,
        req.user!.id,
        weeklyGoalTag,
        req.user!.id
      );

    const countId = Number(info.lastInsertRowid);
    const insertItem = db.prepare(
      `INSERT INTO count_items (
        count_id, product_id, snapshot_erp_stock, snapshot_committed_stock,
        snapshot_cost_price, historical_alert_text
      ) VALUES (?, ?, ?, ?, ?, ?)`
    );

    let insertedItems = 0;
    for (const pid of uniqueProductIds) {
      let bal = db
        .prepare(
          `SELECT ib.erp_physical_stock, ib.committed_stock, p.cost_price
           FROM inventory_balances ib
           JOIN products p ON p.id = ib.product_id
           WHERE ib.product_id = ? AND ib.location_id = ?`
        )
        .get(pid, locId) as
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
        ).run(pid, locId);
        bal = { erp_physical_stock: 0, committed_stock: 0, cost_price: prod.cost_price };
      }

      const alertText = buildHistoricalAlertForItem(pid, locId);
      insertItem.run(
        countId,
        pid,
        bal.erp_physical_stock,
        bal.committed_stock,
        bal.cost_price,
        alertText
      );
      insertedItems += 1;
    }

    if (insertedItems === 0) {
      throw new Error('Ninguno de los artículos seleccionados existe en el catálogo maestro.');
    }

    recordCountStateTransition({
      countId,
      locationId: locId,
      previousStatus: null,
      newStatus: CountStatus.EJECUCION,
      user: req.user!,
      reason: `Planilla de conteo ciego validada e ingresada en EJECUCIÓN mediante ${actionLabel} (${insertedItems} artículo/s).`,
      metadata: {
        countNumber: finalCountNumber,
        documentUid: finalDocumentUid,
        actionType: actionType || 'PRINT',
        assignedCounterId: resolvedCounterId,
        itemsCount: insertedItems,
      },
      ipAddress: getClientIp(req),
    });

    if (resolvedCounterId && resolvedCounterId !== req.user!.id) {
      createNotification({
        targetUserId: resolvedCounterId,
        severity: 'INFO',
        title: `Planilla ciega validada: ${finalCountNumber}`,
        message: `Conteo en ${loc.name} (${insertedItems} artículos) emitido por ${actionLabel} y habilitado para ejecución.`,
        entityType: 'COUNT',
        entityId: countId,
      });
    }

    if (req.user!.role !== UserRole.JEFE_STOCK) {
      createNotification({
        targetRole: UserRole.JEFE_STOCK,
        severity: 'INFO',
        title: `Planilla ciega validada: ${finalCountNumber}`,
        message: `${req.user!.fullName} emitió planilla ciega (${actionLabel}) en ${loc.name} (${insertedItems} artículos) en EJECUCIÓN.`,
        entityType: 'COUNT',
        entityId: countId,
      });
    }

    logAudit({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'BLIND_SHEET_VALIDATED_AND_REGISTERED',
      entityType: 'COUNT',
      entityId: countId,
      locationId: locId,
      newValue: {
        countNumber: finalCountNumber,
        documentUid: finalDocumentUid,
        status: CountStatus.EJECUCION,
        actionType: actionType || 'PRINT',
        assignedCounterId: resolvedCounterId,
        itemsCount: insertedItems,
      },
      ipAddress: getClientIp(req),
    });

    return {
      ok: true,
      alreadyRegistered: false,
      countId,
      countNumber: finalCountNumber,
      documentUid: finalDocumentUid,
      status: CountStatus.EJECUCION,
      itemsCount: insertedItems,
    };
  });

  const result = registerTx();
  res.status(201).json(result);
});

const ALLOWED_COUNT_TRANSITIONS: Record<CountStatus, CountStatus[]> = {
  [CountStatus.EJECUCION]: [CountStatus.ENTREGADO],
  [CountStatus.ENTREGADO]: [CountStatus.APROBADO, CountStatus.RECHAZADO],
  [CountStatus.APROBADO]: [],
  [CountStatus.RECHAZADO]: [CountStatus.EJECUCION],
};

function canTransitionCountStatus(from: string, to: CountStatus): boolean {
  const allowed = ALLOWED_COUNT_TRANSITIONS[from as CountStatus];
  return Array.isArray(allowed) && allowed.includes(to);
}

const BLIND_COUNTER_RESTRICTED_STATUSES = new Set<string>([
  CountStatus.EJECUCION,
  CountStatus.RECHAZADO,
]);

function recordCountStateTransition(params: {
  countId: number;
  locationId: number | null;
  previousStatus: string | null;
  newStatus: CountStatus;
  user: AuthUser;
  reason: string;
  metadata?: unknown;
  ipAddress?: string;
}): void {
  db.prepare(
    `INSERT INTO count_state_history (
      count_id, previous_status, new_status, changed_by_user_id,
      changed_by_username, reason, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.countId,
    params.previousStatus,
    params.newStatus,
    params.user.id,
    params.user.username,
    params.reason.trim(),
    params.metadata !== undefined ? JSON.stringify(params.metadata) : null
  );

  logAudit({
    userId: params.user.id,
    username: params.user.username,
    action: 'COUNT_STATE_TRANSITION',
    entityType: 'COUNT',
    entityId: params.countId,
    locationId: params.locationId,
    oldValue: params.previousStatus ? { status: params.previousStatus } : null,
    newValue: {
      status: params.newStatus,
      reason: params.reason.trim(),
      ...(typeof params.metadata === 'object' && params.metadata !== null ? params.metadata : {}),
    },
    ipAddress: params.ipAddress,
  });
}

function getAttachmentsCountForCount(countId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM attachments
       WHERE (entity_type IN ('COUNT_SHEET', 'ADJUSTMENT') AND entity_id = ?)
          OR (entity_type = 'COUNT_ITEM' AND entity_id IN (SELECT id FROM count_items WHERE count_id = ?))`
    )
    .get(countId, countId) as { cnt: number };
  return Number(row.cnt || 0);
}

function getDocumentaryEvidenceCountForCount(countId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM attachments
       WHERE (entity_type IN ('COUNT_SHEET', 'ADJUSTMENT') AND entity_id = ?)
          OR (entity_type = 'COUNT_ITEM' AND entity_id IN (SELECT id FROM count_items WHERE count_id = ?))`
    )
    .get(countId, countId) as { cnt: number };
  return Number(row.cnt || 0);
}

app.get('/api/counts', requireAuth, (req: AuthenticatedRequest, res) => {
  const statusFilter = String(req.query.status || '').trim();
  const locationGroupFilter = String(req.query.locationGroup || '').trim();
  const locationId = req.query.locationId ? parsePositiveInt(req.query.locationId) : null;
  const counterId = req.query.counterId ? parsePositiveInt(req.query.counterId) : null;
  const dateFrom = String(req.query.dateFrom || '').trim();
  const dateTo = String(req.query.dateTo || '').trim();
  const countNumberFilter = String(req.query.countNumber || '').trim();

  if (
    locationId &&
    req.user!.role === UserRole.RESPONSABLE_DEPOSITO &&
    !userCanAccessLocation(req.user!, locationId)
  ) {
    res.status(403).json({ error: 'No tiene permisos para consultar conteos de esta ubicación.' });
    return;
  }

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
  if (locationGroupFilter) {
    conditions.push('l.group_type = ?');
    params.push(locationGroupFilter);
  }
  if (locationId) {
    conditions.push('c.location_id = ?');
    params.push(locationId);
  }
  if (counterId) {
    conditions.push('c.assigned_counter_id = ?');
    params.push(counterId);
  }
  if (dateFrom) {
    conditions.push('c.scheduled_date >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push('c.scheduled_date <= ?');
    params.push(dateTo);
  }
  if (countNumberFilter) {
    conditions.push('UPPER(c.count_number) LIKE ?');
    params.push(`%${countNumberFilter.toUpperCase()}%`);
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT c.*, l.name as location_name, l.code as location_code, l.group_type as location_group,
        COALESCE(uc.full_name, 'Sin asignar') as counter_name,
        uw.full_name as warehouse_manager_name,
        ucb.full_name as created_by_name,
        (SELECT COUNT(*) FROM count_items ci WHERE ci.count_id = c.id) as items_count,
        (SELECT COUNT(*) FROM count_items ci WHERE ci.count_id = c.id AND (ci.final_counted_qty IS NOT NULL OR ci.is_not_counted = 1)) as counted_items_count,
        (SELECT COUNT(*) FROM count_items ci WHERE ci.count_id = c.id AND ci.is_not_counted = 1) as not_counted_items_count,
        (SELECT COUNT(*) FROM count_items ci WHERE ci.count_id = c.id AND ci.reconciliation_result IN ('FALTANTE', 'SOBRANTE')) as discrepancies_count,
        (SELECT COUNT(*) FROM count_submissions cs WHERE cs.count_id = c.id) as submissions_count,
        (
          SELECT COUNT(*) FROM attachments a
          WHERE (a.entity_type IN ('COUNT_SHEET', 'ADJUSTMENT') AND a.entity_id = c.id)
             OR (a.entity_type = 'COUNT_ITEM' AND a.entity_id IN (SELECT ci2.id FROM count_items ci2 WHERE ci2.count_id = c.id))
        ) as attachments_count
       FROM counts c
       JOIN locations l ON l.id = c.location_id
       LEFT JOIN users uc ON uc.id = c.assigned_counter_id
       LEFT JOIN users uw ON uw.id = c.warehouse_manager_id
       LEFT JOIN users ucb ON ucb.id = c.created_by_user_id
       ${whereSql}
       ORDER BY c.updated_at DESC, c.scheduled_date DESC, c.id DESC`
    )
    .all(...params) as Array<Record<string, unknown>>;

  // Blind count protection: hide discrepancy summary from CONTADOR while unsubmitted
  const sanitized = rows.map((r) => {
    if (
      req.user!.role === UserRole.CONTADOR &&
      BLIND_COUNTER_RESTRICTED_STATUSES.has(String(r.status))
    ) {
      return { ...r, discrepancies_count: null };
    }
    return r;
  });

  res.json({ counts: sanitized });
});

function validateCounterAssignmentForCount(
  counterId: number,
  locationId: number,
  productIds: number[]
): { ok: true; counterUser: AuthUser } | { ok: false; status: number; error: string } {
  const counterRow = db.prepare('SELECT * FROM users WHERE id = ?').get(counterId) as
    | Record<string, unknown>
    | undefined;
  if (!counterRow || !counterRow.is_active) {
    return {
      ok: false,
      status: 400,
      error: 'El responsable de conteo seleccionado no existe o está deshabilitado.',
    };
  }
  const counterUser = mapDbUser(counterRow);
  if (counterUser.role !== UserRole.CONTADOR && counterUser.role !== UserRole.JEFE_STOCK) {
    return {
      ok: false,
      status: 400,
      error: `El usuario "${counterUser.username}" no tiene rol habilitado para ejecutar conteos.`,
    };
  }
  if (
    counterUser.role === UserRole.CONTADOR &&
    !userCanAccessLocation(counterUser, locationId)
  ) {
    return {
      ok: false,
      status: 403,
      error: `El responsable "${counterUser.fullName}" no tiene autorización asignada sobre este depósito.`,
    };
  }
  if (
    counterUser.role === UserRole.CONTADOR &&
    counterUser.assignedFamilies.length > 0 &&
    productIds.length > 0
  ) {
    const allowedFams = new Set(counterUser.assignedFamilies.map((f) => f.trim().toLowerCase()));
    const prodRows = db
      .prepare(
        `SELECT id, sku, family FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`
      )
      .all(...productIds) as Array<{ id: number; sku: string; family: string }>;

    const unauthorized = prodRows.find((p) => !allowedFams.has(String(p.family || '').trim().toLowerCase()));
    if (unauthorized) {
      return {
        ok: false,
        status: 403,
        error: `El artículo ${unauthorized.sku} (familia "${unauthorized.family}") no corresponde a las familias asignadas a ${counterUser.fullName}.`,
      };
    }
  }
  return { ok: true, counterUser };
}

function getPostSnapshotMovementsForCount(
  countId: number,
  locationId: number,
  createdAt: string,
  productIds: number[]
): Array<Record<string, unknown>> {
  if (productIds.length === 0) return [];
  return db
    .prepare(
      `SELECT im.*, p.sku, p.description
       FROM inventory_movements im
       JOIN products p ON p.id = im.product_id
       WHERE im.location_id = ?
         AND im.product_id IN (${productIds.map(() => '?').join(',')})
         AND im.created_at > ?
         AND NOT (im.reference_type = 'COUNT_CLOSURE' AND im.reference_id = ?)
       ORDER BY im.created_at DESC`
    )
    .all(locationId, ...productIds, createdAt, String(countId)) as Array<Record<string, unknown>>;
}

app.get('/api/counts/:id', requireAuth, (req: AuthenticatedRequest, res) => {
  const countId = parsePositiveInt(req.params.id);
  if (!countId) {
    res.status(400).json({ error: 'Identificador de conteo inválido.' });
    return;
  }
  const countRow = db
    .prepare(
      `SELECT c.*, l.name as location_name, l.code as location_code, l.group_type as location_group,
        COALESCE(uc.full_name, 'Sin asignar') as counter_name, uc.username as counter_username,
        uw.full_name as warehouse_manager_name, ucb.full_name as created_by_name,
        usub.full_name as submitted_by_name,
        ua.full_name as approved_by_name,
        urj.full_name as rejected_by_name,
        ucl.full_name as closed_by_name
       FROM counts c
       JOIN locations l ON l.id = c.location_id
       LEFT JOIN users uc ON uc.id = c.assigned_counter_id
       LEFT JOIN users uw ON uw.id = c.warehouse_manager_id
       JOIN users ucb ON ucb.id = c.created_by_user_id
       LEFT JOIN users usub ON usub.id = c.submitted_by_user_id
       LEFT JOIN users ua ON ua.id = c.approved_by_user_id
       LEFT JOIN users urj ON urj.id = c.rejected_by_user_id
       LEFT JOIN users ucl ON ucl.id = c.closed_by_user_id
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
    req.user!.role !== UserRole.AUDITORIA_DIRECCION &&
    BLIND_COUNTER_RESTRICTED_STATUSES.has(String(countRow.status));

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
        is_not_counted: it.is_not_counted,
        not_counted_reason: it.not_counted_reason,
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
  const detectedPostMovements = getPostSnapshotMovementsForCount(
    countId,
    Number(countRow.location_id),
    String(countRow.created_at),
    productIds
  );
  const hasPostFlag = detectedPostMovements.length > 0 ? 1 : 0;
  if (Number(countRow.has_post_snapshot_movements || 0) !== hasPostFlag) {
    db.prepare('UPDATE counts SET has_post_snapshot_movements = ? WHERE id = ?').run(hasPostFlag, countId);
    countRow.has_post_snapshot_movements = hasPostFlag;
  }
  const postSnapshotMovements =
    req.user!.role === UserRole.JEFE_STOCK || req.user!.role === UserRole.AUDITORIA_DIRECCION
      ? detectedPostMovements
      : [];

  const sheetAttachments =
    req.user!.role === UserRole.CONTADOR
      ? db
          .prepare("SELECT * FROM attachments WHERE entity_type = 'COUNT_SHEET' AND entity_id = ?")
          .all(countId)
      : db
          .prepare("SELECT * FROM attachments WHERE entity_type IN ('COUNT_SHEET', 'ADJUSTMENT') AND entity_id = ?")
          .all(countId);

  const stateHistory = db
    .prepare(
      `SELECT h.*, u.full_name as changed_by_full_name
       FROM count_state_history h
       LEFT JOIN users u ON u.id = h.changed_by_user_id
       WHERE h.count_id = ?
       ORDER BY h.id DESC`
    )
    .all(countId);

  const rawSubmissions = db
    .prepare(
      `SELECT cs.*, us.full_name as submitted_by_full_name, ur.full_name as reviewed_by_full_name
       FROM count_submissions cs
       LEFT JOIN users us ON us.id = cs.submitted_by_user_id
       LEFT JOIN users ur ON ur.id = cs.reviewed_by_user_id
       WHERE cs.count_id = ?
       ORDER BY cs.version_number DESC`
    )
    .all(countId) as Array<Record<string, unknown>>;

  const submissions = rawSubmissions.map((sub) => {
    let parsedItems: Array<Record<string, unknown>> = [];
    try {
      parsedItems = JSON.parse(String(sub.items_snapshot_json || '[]'));
    } catch {
      parsedItems = [];
    }
    if (isBlindStageForCounter) {
      parsedItems = parsedItems.map((it) => ({
        ...it,
        snapshot_erp_stock: null,
        snapshot_committed_stock: null,
        difference: null,
        reconciliation_result: null,
      }));
    }
    return {
      ...sub,
      items: parsedItems,
    };
  });

  res.json({
    count: countRow,
    items,
    isBlindRestricted: isBlindStageForCounter,
    postSnapshotMovements,
    sheetAttachments,
    stateHistory,
    submissions,
  });
});

app.post('/api/counts', requireAuth, requireRole(UserRole.JEFE_STOCK), (req: AuthenticatedRequest, res) => {
  const { locationId, scheduledDate, assignedCounterId, productIds, weeklyGoalTag } =
    req.body as {
      locationId?: number;
      scheduledDate?: string;
      assignedCounterId?: number | null;
      productIds?: number[];
      weeklyGoalTag?: string;
      saveAsDraft?: boolean;
    };

  if (!locationId || !scheduledDate || !Array.isArray(productIds) || productIds.length === 0) {
    res.status(400).json({
      error: 'Ubicación, fecha programada y al menos un artículo son requeridos.',
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

  const cleanCounterId = assignedCounterId ? Number(assignedCounterId) : null;
  if (cleanCounterId) {
    const check = validateCounterAssignmentForCount(cleanCounterId, Number(locationId), productIds);
    if (!check.ok) {
      res.status(check.status).json({ error: check.error });
      return;
    }
  }

  const initialStatus: CountStatus = CountStatus.EJECUCION;
  const countNumber = nextSequenceNumber('CNT', 'counts', 'count_number');
  const documentUid = `DOC-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;

  const createTx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO counts (
          count_number, document_uid, location_id, scheduled_date,
          assigned_counter_id, warehouse_manager_id, created_by_user_id,
          status, weekly_goal_tag, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(
        countNumber,
        documentUid,
        locationId,
        scheduledDate,
        cleanCounterId,
        loc.manager_user_id || null,
        req.user!.id,
        initialStatus,
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

    recordCountStateTransition({
      countId,
      locationId: Number(locationId),
      previousStatus: null,
      newStatus: CountStatus.EJECUCION,
      user: req.user!,
      reason: cleanCounterId
        ? `Conteo creado en EJECUCIÓN y asignado al responsable ID ${cleanCounterId} (${productIds.length} artículos).`
        : `Conteo creado en EJECUCIÓN (${productIds.length} artículos, pendiente de asignación).`,
      metadata: { countNumber, assignedCounterId: cleanCounterId, itemsCount: productIds.length },
      ipAddress: getClientIp(req),
    });

    if (cleanCounterId) {
      createNotification({
        targetUserId: cleanCounterId,
        severity: 'INFO',
        title: `Nuevo conteo en ejecución: ${countNumber}`,
        message: `Se asignó conteo ciego en ${loc.name} para el ${scheduledDate} (${productIds.length} artículos).`,
        entityType: 'COUNT',
        entityId: countId,
      });
    }

    logAudit({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'COUNT_CREATED',
      entityType: 'COUNT',
      entityId: countId,
      locationId: Number(locationId),
      newValue: {
        countNumber,
        scheduledDate,
        status: initialStatus,
        assignedCounterId: cleanCounterId,
        itemsCount: productIds.length,
      },
      ipAddress: getClientIp(req),
    });

    return { countId, countNumber, documentUid, status: initialStatus };
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

    for (const a of assignments) {
      if (!a.productIds || a.productIds.length === 0) continue;
      const check = validateCounterAssignmentForCount(
        Number(a.counterId),
        Number(locationId),
        a.productIds
      );
      if (!check.ok) {
        res.status(check.status).json({ error: check.error });
        return;
      }
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
              status, weekly_goal_tag, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'EJECUCION', ?, datetime('now'))`
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

        recordCountStateTransition({
          countId,
          locationId: Number(locationId),
          previousStatus: null,
          newStatus: CountStatus.EJECUCION,
          user: req.user!,
          reason: `Conteo generado en EJECUCIÓN y asignado por planificación inteligente (${a.productIds.length} artículos).`,
          metadata: { countNumber, assignedCounterId: a.counterId },
          ipAddress: getClientIp(req),
        });

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

app.post(
  '/api/counts/:id/assign',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK),
  (req: AuthenticatedRequest, res) => {
    const countId = parsePositiveInt(req.params.id);
    if (!countId) {
      res.status(400).json({ error: 'Identificador de conteo inválido.' });
      return;
    }
    const { assignedCounterId, reason } = req.body as {
      assignedCounterId?: number;
      reason?: string;
    };
    if (!assignedCounterId) {
      res.status(400).json({ error: 'Debe seleccionar un responsable de conteo.' });
      return;
    }

    const countRow = db.prepare('SELECT * FROM counts WHERE id = ?').get(countId) as
      | Record<string, unknown>
      | undefined;
    if (!countRow) {
      res.status(404).json({ error: 'Conteo no encontrado.' });
      return;
    }
    if (countRow.status === CountStatus.APROBADO) {
      res.status(403).json({ error: 'El conteo está aprobado y no puede reasignarse.' });
      return;
    }
    if (countRow.status !== CountStatus.EJECUCION) {
      res.status(400).json({
        error: `Solo se puede asignar o cambiar responsable cuando el conteo está en EJECUCIÓN (estado actual: ${countRow.status}).`,
      });
      return;
    }

    const productIds = (
      db.prepare('SELECT product_id FROM count_items WHERE count_id = ?').all(countId) as Array<{
        product_id: number;
      }>
    ).map((r) => r.product_id);

    const check = validateCounterAssignmentForCount(
      Number(assignedCounterId),
      Number(countRow.location_id),
      productIds
    );
    if (!check.ok) {
      res.status(check.status).json({ error: check.error });
      return;
    }

    const assignTx = db.transaction(() => {
      db.prepare(
        `UPDATE counts SET
          assigned_counter_id = ?,
          updated_at = datetime('now')
         WHERE id = ?`
      ).run(Number(assignedCounterId), countId);

      logAudit({
        userId: req.user!.id,
        username: req.user!.username,
        action: 'COUNT_COUNTER_ASSIGNED',
        entityType: 'COUNT',
        entityId: countId,
        locationId: Number(countRow.location_id),
        oldValue: { assignedCounterId: countRow.assigned_counter_id ?? null },
        newValue: {
          assignedCounterId: Number(assignedCounterId),
          reason:
            reason?.trim() ||
            `Asignado al responsable ${check.counterUser.fullName} (${check.counterUser.username}).`,
        },
        ipAddress: getClientIp(req),
      });

      createNotification({
        targetUserId: Number(assignedCounterId),
        severity: 'INFO',
        title: `Conteo asignado: ${countRow.count_number}`,
        message: `Se le asignó el conteo ${countRow.count_number} (${productIds.length} artículos) programado para ${countRow.scheduled_date}.`,
        entityType: 'COUNT',
        entityId: countId,
      });
    });

    assignTx();
    res.json({ ok: true, status: CountStatus.EJECUCION });
  }
);

function executeReopenCount(req: AuthenticatedRequest, res: express.Response): void {
  const countId = parsePositiveInt(req.params.id);
  if (!countId) {
    res.status(400).json({ error: 'Identificador de conteo inválido.' });
    return;
  }
  const countRow = db.prepare('SELECT * FROM counts WHERE id = ?').get(countId) as
    | Record<string, unknown>
    | undefined;
  if (!countRow) {
    res.status(404).json({ error: 'Conteo no encontrado.' });
    return;
  }
  if (countRow.status === CountStatus.APROBADO) {
    res.status(403).json({ error: 'El conteo ya fue aprobado y no puede reabrirse.' });
    return;
  }
  if (
    req.user!.role === UserRole.CONTADOR &&
    Number(countRow.assigned_counter_id) !== req.user!.id
  ) {
    res.status(403).json({ error: 'Solo el contador asignado o el Jefe puede retomar este conteo.' });
    return;
  }

  const prevStatus = String(countRow.status);
  if (!canTransitionCountStatus(prevStatus, CountStatus.EJECUCION)) {
    res.status(400).json({
      error: `Transición no permitida: solo un conteo RECHAZADO puede devolverse a EJECUCIÓN (estado actual: ${prevStatus}).`,
    });
    return;
  }

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE counts SET
        status = 'EJECUCION',
        executed_at = COALESCE(executed_at, datetime('now')),
        started_by_user_id = COALESCE(started_by_user_id, ?),
        updated_at = datetime('now')
       WHERE id = ?`
    ).run(req.user!.id, countId);

    recordCountStateTransition({
      countId,
      locationId: Number(countRow.location_id),
      previousStatus: prevStatus,
      newStatus: CountStatus.EJECUCION,
      user: req.user!,
      reason: 'Conteo devuelto a EJECUCIÓN para corrección de resultados tras rechazo.',
      ipAddress: getClientIp(req),
    });

    logAudit({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'COUNT_REOPENED_FROM_REJECTION',
      entityType: 'COUNT',
      entityId: countId,
      locationId: Number(countRow.location_id),
      oldValue: { status: prevStatus },
      newValue: { status: CountStatus.EJECUCION },
      ipAddress: getClientIp(req),
    });
  });

  tx();
  res.json({ ok: true, status: CountStatus.EJECUCION });
}

app.post(
  '/api/counts/:id/reopen',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK, UserRole.CONTADOR),
  executeReopenCount
);

app.post(
  '/api/counts/:id/start',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK, UserRole.CONTADOR),
  executeReopenCount
);

app.post(
  '/api/counts/:id/mark-printed',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK, UserRole.CONTADOR, UserRole.RESPONSABLE_DEPOSITO),
  (req: AuthenticatedRequest, res) => {
  const countId = parsePositiveInt(req.params.id);
  if (!countId) {
    res.status(400).json({ error: 'Identificador de conteo inválido.' });
    return;
  }

  const countRow = db.prepare('SELECT * FROM counts WHERE id = ?').get(countId) as
    | Record<string, unknown>
    | undefined;
  if (!countRow) {
    res.status(404).json({ error: 'Conteo no encontrado.' });
    return;
  }

  if (
    req.user!.role === UserRole.CONTADOR &&
    Number(countRow.assigned_counter_id) !== req.user!.id
  ) {
    res.status(403).json({ error: 'Solo el responsable asignado o el Jefe puede imprimir este conteo.' });
    return;
  }
  if (
    req.user!.role === UserRole.RESPONSABLE_DEPOSITO &&
    !userCanAccessLocation(req.user!, Number(countRow.location_id))
  ) {
    res.status(403).json({ error: 'No tiene permisos sobre la ubicación de este conteo.' });
    return;
  }

  if (countRow.status !== CountStatus.APROBADO) {
    db.prepare(
      `UPDATE counts SET
        blind_printed_at = COALESCE(blind_printed_at, datetime('now')),
        executed_at = CASE WHEN status = 'EJECUCION' THEN COALESCE(executed_at, datetime('now')) ELSE executed_at END,
        started_by_user_id = CASE WHEN status = 'EJECUCION' THEN COALESCE(started_by_user_id, ?) ELSE started_by_user_id END,
        updated_at = datetime('now')
       WHERE id = ?`
    ).run(req.user!.id, countId);
  }

  logAudit({
    userId: req.user!.id,
    username: req.user!.username,
    action: 'BLIND_SHEET_PRINTED',
    entityType: 'COUNT',
    entityId: countId,
    locationId: Number(countRow.location_id),
    ipAddress: getClientIp(req),
  });
  res.json({ ok: true });
});

function sanitizeSpreadsheetCell(value: unknown): string {
  const text = String(value ?? '');
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

app.get(
  '/api/counts/:id/export-excel',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK, UserRole.CONTADOR, UserRole.RESPONSABLE_DEPOSITO),
  (req: AuthenticatedRequest, res) => {
    const countId = parsePositiveInt(req.params.id);
    if (!countId) {
      res.status(400).json({ error: 'Identificador de conteo inválido.' });
      return;
    }

    const countRow = db
      .prepare(
        `SELECT c.*, l.name as location_name, l.code as location_code
         FROM counts c
         JOIN locations l ON l.id = c.location_id
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
      res.status(403).json({ error: 'Solo el contador asignado o el Jefe puede descargar esta planilla.' });
      return;
    }
    if (
      req.user!.role === UserRole.RESPONSABLE_DEPOSITO &&
      !userCanAccessLocation(req.user!, Number(countRow.location_id))
    ) {
      res.status(403).json({ error: 'No tiene permisos sobre la ubicación de este conteo.' });
      return;
    }

    if (countRow.status !== CountStatus.EJECUCION) {
      res.status(400).json({
        error: `La planilla Excel solo puede descargarse cuando el conteo está en EJECUCIÓN (estado actual: ${countRow.status}).`,
      });
      return;
    }

    const rawItems = db
      .prepare(
        `SELECT ci.*, p.sku, p.description, p.family, p.brand, p.unit_of_measure
         FROM count_items ci
         JOIN products p ON p.id = ci.product_id
         WHERE ci.count_id = ?
         ORDER BY p.description ASC`
      )
      .all(countId) as Array<Record<string, unknown>>;

    const submissionsCntRow = db
      .prepare('SELECT COUNT(*) as cnt FROM count_submissions WHERE count_id = ?')
      .get(countId) as { cnt: number };
    const isPostRejection =
      Boolean(countRow.rejected_at) || Number(submissionsCntRow.cnt || 0) > 0;

    // Strictly blind export: never expose snapshot_erp_stock, difference, or reconciliation_result
    const sheetRows = rawItems.map((it) => {
      const bulkVal = isPostRejection
        ? it.recount_bulk_qty ?? it.bulk_qty
        : it.bulk_qty;
      const looseVal = isPostRejection
        ? it.recount_loose_qty ?? it.loose_qty
        : it.loose_qty;

      return {
        SKU: sanitizeSpreadsheetCell(it.sku),
        Descripción: sanitizeSpreadsheetCell(it.description),
        Familia: sanitizeSpreadsheetCell(it.family || 'General'),
        Marca: sanitizeSpreadsheetCell(it.brand || 'Sin marca'),
        'U.M.': sanitizeSpreadsheetCell(it.unit_of_measure || 'UN'),
        'Unidades / Bultos':
          bulkVal !== null && bulkVal !== undefined && Number.isFinite(Number(bulkVal))
            ? Number(bulkVal)
            : '',
        'Unidades Sueltas':
          looseVal !== null && looseVal !== undefined && Number.isFinite(Number(looseVal))
            ? Number(looseVal)
            : '',
        Observaciones: sanitizeSpreadsheetCell(it.counter_observations || ''),
      };
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(sheetRows, {
      header: [
        'SKU',
        'Descripción',
        'Familia',
        'Marca',
        'U.M.',
        'Unidades / Bultos',
        'Unidades Sueltas',
        'Observaciones',
      ],
    });
    ws['!cols'] = [
      { wch: 18 },
      { wch: 44 },
      { wch: 18 },
      { wch: 18 },
      { wch: 8 },
      { wch: 18 },
      { wch: 18 },
      { wch: 32 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Planilla_Conteo');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    db.prepare(
      `UPDATE counts SET
        blind_printed_at = COALESCE(blind_printed_at, datetime('now')),
        executed_at = COALESCE(executed_at, datetime('now')),
        started_by_user_id = COALESCE(started_by_user_id, ?),
        updated_at = datetime('now')
       WHERE id = ?`
    ).run(req.user!.id, countId);

    logAudit({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'BLIND_SHEET_EXCEL_DOWNLOADED',
      entityType: 'COUNT',
      entityId: countId,
      locationId: Number(countRow.location_id),
      newValue: {
        countNumber: countRow.count_number,
        itemsCount: rawItems.length,
        isPostRejection,
      },
      ipAddress: getClientIp(req),
    });

    const safeCountNumber = String(countRow.count_number || countId).replace(/[^A-Za-z0-9_-]/g, '_');
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Planilla_Conteo_${safeCountNumber}.xlsx"`
    );
    res.send(buffer);
  }
);

function handleCountResultsOrPresentation(
  req: AuthenticatedRequest,
  res: express.Response,
  forcePresent: boolean
): void {
  const countId = parsePositiveInt(req.params.id);
  if (!countId) {
    res.status(400).json({ error: 'Identificador de conteo inválido.' });
    return;
  }

  const countRow = db.prepare('SELECT * FROM counts WHERE id = ?').get(countId) as
    | Record<string, unknown>
    | undefined;
  if (!countRow) {
    res.status(404).json({ error: 'Conteo no encontrado.' });
    return;
  }

  const prevStatus = String(countRow.status);
  if (prevStatus === CountStatus.APROBADO || prevStatus === CountStatus.ENTREGADO) {
    res.status(403).json({
      error: `El conteo se encuentra en estado ${prevStatus} y no admite edición por parte del contador.`,
    });
    return;
  }
  if (prevStatus === CountStatus.RECHAZADO) {
    res.status(400).json({
      error: 'El conteo fue RECHAZADO. Primero debe reabrirlo a estado EJECUCIÓN para poder corregir y volver a presentar resultados.',
    });
    return;
  }

  if (
    req.user!.role === UserRole.RESPONSABLE_DEPOSITO ||
    req.user!.role === UserRole.AUDITORIA_DIRECCION
  ) {
    res.status(403).json({ error: 'Su perfil no está habilitado para modificar o presentar resultados de conteo.' });
    return;
  }

  if (
    req.user!.role === UserRole.CONTADOR &&
    Number(countRow.assigned_counter_id) !== req.user!.id
  ) {
    res.status(403).json({
      error: 'Los contadores solamente pueden trabajar y presentar sus conteos asignados.',
    });
    return;
  }

  const body = req.body as {
    items?: Array<{
      itemId: number;
      bulkQty?: number | null;
      looseQty?: number | null;
      countedQty?: number | null;
      isNotCounted?: boolean;
      notCountedReason?: string;
      observations?: string;
    }>;
    counterSignatureName?: string;
    generalObservations?: string;
    submitForReview?: boolean;
  };

  const submitForReview = forcePresent || Boolean(body.submitForReview);

  if (submitForReview && !canTransitionCountStatus(prevStatus, CountStatus.ENTREGADO)) {
    res.status(400).json({
      error: `Transición no permitida: el conteo está en estado ${prevStatus}. Debe estar en EJECUCIÓN para presentarlo.`,
    });
    return;
  }

  const items = Array.isArray(body.items) ? body.items : [];
  if (!submitForReview && items.length === 0) {
    res.status(400).json({ error: 'Ingrese las cantidades contadas.' });
    return;
  }

  const submissionsCountRow = db
    .prepare('SELECT COUNT(*) as cnt FROM count_submissions WHERE count_id = ?')
    .get(countId) as { cnt: number };
  const isRecount = Boolean(countRow.rejected_at) || Number(submissionsCountRow.cnt || 0) > 0;
  const generalObsTrimmed =
    body.generalObservations !== undefined
      ? String(body.generalObservations).trim()
      : String(countRow.counter_general_notes || '').trim();
  const counterSigTrimmed =
    body.counterSignatureName !== undefined
      ? String(body.counterSignatureName).trim()
      : String(countRow.counter_signature_name || '').trim();

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

      const isNotCounted = Boolean(entry.isNotCounted);
      const notCountedReason = String(entry.notCountedReason || '').trim();
      const obsText = String(entry.observations ?? '').trim();

      if (isNotCounted) {
        if (submitForReview && !notCountedReason) {
          throw new Error(
            'Todo artículo marcado como "No contado" requiere una justificación obligatoria antes de presentar.'
          );
        }
        if (isRecount) {
          db.prepare(
            `UPDATE count_items SET
              is_not_counted = 1,
              not_counted_reason = ?,
              recount_bulk_qty = NULL,
              recount_loose_qty = NULL,
              recount_qty = NULL,
              final_counted_qty = NULL,
              difference = NULL,
              reconciliation_result = NULL,
              counter_observations = COALESCE(NULLIF(?, ''), counter_observations),
              updated_at = datetime('now')
             WHERE id = ?`
          ).run(notCountedReason, obsText, existing.id);
        } else {
          db.prepare(
            `UPDATE count_items SET
              is_not_counted = 1,
              not_counted_reason = ?,
              bulk_qty = NULL,
              loose_qty = NULL,
              counted_qty = NULL,
              final_counted_qty = NULL,
              difference = NULL,
              reconciliation_result = NULL,
              counter_observations = ?,
              updated_at = datetime('now')
             WHERE id = ?`
          ).run(notCountedReason, obsText, existing.id);
        }
        continue;
      }

      const hasRawBulk =
        entry.bulkQty !== undefined &&
        entry.bulkQty !== null &&
        String(entry.bulkQty).trim() !== '';
      const hasRawLoose =
        entry.looseQty !== undefined &&
        entry.looseQty !== null &&
        String(entry.looseQty).trim() !== '';
      const parsedBulk = parseOptionalNonNeg(entry.bulkQty);
      const parsedLoose = parseOptionalNonNeg(entry.looseQty);

      if (hasRawBulk && parsedBulk === null) {
        throw new Error(
          `El valor de "Unidades / Bultos" en ${existing.sku} debe ser un número válido mayor o igual a 0.`
        );
      }

      if (hasRawLoose && parsedLoose === null) {
        throw new Error(
          `El valor de "Unidades Sueltas" en ${existing.sku} debe ser un número válido mayor o igual a 0.`
        );
      }

      if (submitForReview && parsedBulk === null && parsedLoose === null) {
        throw new Error(
          'Debe ingresar una cantidad válida (puede ser 0) o justificar como "No contado" en todos los artículos.'
        );
      }

      if (parsedBulk === null && parsedLoose === null) {
        if (isRecount) {
          db.prepare(
            `UPDATE count_items SET
              is_not_counted = 0,
              not_counted_reason = '',
              recount_bulk_qty = NULL,
              recount_loose_qty = NULL,
              recount_qty = NULL,
              counter_observations = COALESCE(NULLIF(?, ''), counter_observations),
              updated_at = datetime('now')
             WHERE id = ?`
          ).run(obsText, existing.id);
        } else {
          db.prepare(
            `UPDATE count_items SET
              is_not_counted = 0,
              not_counted_reason = '',
              bulk_qty = NULL,
              loose_qty = NULL,
              counted_qty = NULL,
              final_counted_qty = NULL,
              difference = NULL,
              reconciliation_result = NULL,
              counter_observations = ?,
              updated_at = datetime('now')
             WHERE id = ?`
          ).run(obsText, existing.id);
        }
        continue;
      }

      const effectiveBulk = parsedBulk ?? 0;
      const effectiveLoose = parsedLoose ?? 0;
      const qty = Math.round((effectiveBulk + effectiveLoose) * 10000) / 10000;
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
            is_not_counted = 0,
            not_counted_reason = '',
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
        ).run(effectiveBulk, effectiveLoose, qty, qty, diff, recResult, obsText, histAlert, existing.id);
      } else {
        db.prepare(
          `UPDATE count_items SET
            is_not_counted = 0,
            not_counted_reason = '',
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
        ).run(effectiveBulk, effectiveLoose, qty, qty, diff, recResult, obsText, histAlert, existing.id);
      }

      if (submitForReview) {
        db.prepare(
          "UPDATE inventory_balances SET last_counted_at = datetime('now') WHERE product_id = ? AND location_id = ?"
        ).run(existing.product_id, countRow.location_id);
      }
    }

    if (submitForReview) {
      // 1. All items must either have complete bulk+loose OR justified not-counted
      const allCountItems = db
        .prepare(
          `SELECT ci.*, p.sku, p.description
           FROM count_items ci
           JOIN products p ON p.id = ci.product_id
           WHERE ci.count_id = ?
           ORDER BY p.description ASC`
        )
        .all(countId) as Array<Record<string, unknown>>;

      const missingItems: string[] = [];
      for (const it of allCountItems) {
        const isUncounted = Number(it.is_not_counted || 0) === 1;
        if (isUncounted) {
          if (!String(it.not_counted_reason || '').trim()) {
            missingItems.push(`${it.sku} (falta justificación de no conteo)`);
          }
          continue;
        }
        const hasValues = isRecount
          ? it.recount_bulk_qty !== null && it.final_counted_qty !== null
          : it.bulk_qty !== null && it.final_counted_qty !== null;
        if (!hasValues) {
          missingItems.push(String(it.sku));
        }
      }

      if (missingItems.length > 0) {
        throw new Error(
          `Condición de presentación incumplida: faltan completar resultados o justificación de no conteo en ${missingItems.length} artículo(s) (${missingItems.slice(0, 4).join(', ')}).`
        );
      }

      // 2. Counter digital signature required
      if (!counterSigTrimmed) {
        throw new Error(
          'Condición de presentación incumplida: debe registrar la firma o responsabilidad digital del contador.'
        );
      }

      // 3. Warehouse manager signature required
      const whSigCurrent = String(countRow.warehouse_signature_name || '').trim();
      if (!whSigCurrent) {
        throw new Error(
          'Condición de presentación incumplida: falta la firma o confirmación del Responsable de Depósito.'
        );
      }

      // 4. Mandatory general count observations
      if (!generalObsTrimmed) {
        throw new Error(
          'Condición de presentación incumplida: debe completar las observaciones generales obligatorias del conteo.'
        );
      }

      // 5. Supporting attachment is advisory on presentation (pending closure if omitted)
      const evidenceCount = getDocumentaryEvidenceCountForCount(countId);
      const pendingEvidence = evidenceCount === 0;

      const maxVerRow = db
        .prepare('SELECT COALESCE(MAX(version_number), 0) as max_ver FROM count_submissions WHERE count_id = ?')
        .get(countId) as { max_ver: number };
      const nextVer = Number(maxVerRow.max_ver || 0) + 1;

      const snapshotItems = allCountItems.map((it) => ({
        item_id: it.id,
        product_id: it.product_id,
        sku: it.sku,
        description: it.description,
        snapshot_erp_stock: it.snapshot_erp_stock,
        snapshot_committed_stock: it.snapshot_committed_stock,
        bulk_qty: isRecount ? it.recount_bulk_qty : it.bulk_qty,
        loose_qty: isRecount ? it.recount_loose_qty : it.loose_qty,
        final_counted_qty: it.final_counted_qty,
        is_not_counted: Number(it.is_not_counted || 0),
        not_counted_reason: it.not_counted_reason || '',
        difference: it.difference,
        reconciliation_result: it.reconciliation_result,
        counter_observations: it.counter_observations || '',
      }));

      db.prepare(
        `INSERT INTO count_submissions (
          count_id, version_number, submitted_by_user_id, submitted_by_username,
          counter_signature_name, warehouse_signature_name, general_observations,
          items_snapshot_json, outcome_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ENTREGADO')`
      ).run(
        countId,
        nextVer,
        req.user!.id,
        req.user!.username,
        counterSigTrimmed,
        whSigCurrent,
        generalObsTrimmed,
        JSON.stringify(snapshotItems)
      );

      db.prepare(
        `UPDATE counts SET
          status = 'ENTREGADO',
          submitted_at = datetime('now'),
          submitted_by_user_id = ?,
          counter_signature_name = ?,
          counter_signed_at = datetime('now'),
          counter_general_notes = ?,
          updated_at = datetime('now')
         WHERE id = ?`
      ).run(req.user!.id, counterSigTrimmed, generalObsTrimmed, countId);

      recordCountStateTransition({
        countId,
        locationId: Number(countRow.location_id),
        previousStatus: prevStatus,
        newStatus: CountStatus.ENTREGADO,
        user: req.user!,
        reason: pendingEvidence
          ? `Conteo entregado para revisión (Versión v${nextVer}) — AVISO: pendiente foto/planilla firmada. Observaciones: ${generalObsTrimmed}`
          : `Conteo entregado para revisión (Versión v${nextVer}). Observaciones: ${generalObsTrimmed}`,
        metadata: {
          versionNumber: nextVer,
          attachmentsCount: evidenceCount,
          pendingDocumentaryEvidence: pendingEvidence,
        },
        ipAddress: getClientIp(req),
      });

      const discrepancies = allCountItems.filter(
        (it) =>
          it.reconciliation_result === ReconciliationResult.FALTANTE ||
          it.reconciliation_result === ReconciliationResult.SOBRANTE ||
          Number(it.is_not_counted || 0) === 1
      ).length;

      createNotification({
        targetRole: UserRole.JEFE_STOCK,
        severity: discrepancies > 0 || pendingEvidence ? 'ALTA' : 'INFO',
        title: `Conteo ${countRow.count_number} entregado para revisión (v${nextVer})`,
        message: `Presentado por ${req.user!.fullName}. ${discrepancies} novedad(es) o diferencia(s).${
          pendingEvidence
            ? ' Pendiente foto/planilla firmada de respaldo.'
            : ''
        }`,
        entityType: 'COUNT',
        entityId: countId,
      });

      logAudit({
        userId: req.user!.id,
        username: req.user!.username,
        action: 'COUNT_PRESENTED_FOR_APPROVAL',
        entityType: 'COUNT',
        entityId: countId,
        locationId: Number(countRow.location_id),
        newValue: {
          versionNumber: nextVer,
          status: CountStatus.ENTREGADO,
          itemsCount: allCountItems.length,
          discrepancies,
          pendingDocumentaryEvidence: pendingEvidence,
        },
        ipAddress: getClientIp(req),
      });
      return { missingEvidenceWarning: pendingEvidence };
    } else {
      db.prepare(
        `UPDATE counts SET
          executed_at = COALESCE(executed_at, datetime('now')),
          started_by_user_id = COALESCE(started_by_user_id, ?),
          counter_signature_name = CASE WHEN ? != '' THEN ? ELSE counter_signature_name END,
          counter_general_notes = CASE WHEN ? THEN ? ELSE counter_general_notes END,
          updated_at = datetime('now')
         WHERE id = ?`
      ).run(
        req.user!.id,
        counterSigTrimmed,
        counterSigTrimmed,
        body.generalObservations !== undefined ? 1 : 0,
        generalObsTrimmed,
        countId
      );

      logAudit({
        userId: req.user!.id,
        username: req.user!.username,
        action: 'COUNT_DRAFT_SAVED',
        entityType: 'COUNT',
        entityId: countId,
        locationId: Number(countRow.location_id),
        newValue: { itemsUpdated: items.length, isRecount },
        ipAddress: getClientIp(req),
      });
      return { missingEvidenceWarning: false };
    }
  });

  try {
    const outcome = tx();
    res.json({
      ok: true,
      status: submitForReview ? CountStatus.ENTREGADO : CountStatus.EJECUCION,
      missingEvidenceWarning: Boolean(outcome?.missingEvidenceWarning),
    });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
}

app.post(
  '/api/counts/:id/submit-results',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK, UserRole.CONTADOR),
  (req: AuthenticatedRequest, res) => {
    handleCountResultsOrPresentation(req, res, false);
  }
);

app.post(
  '/api/counts/:id/present',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK, UserRole.CONTADOR),
  (req: AuthenticatedRequest, res) => {
    handleCountResultsOrPresentation(req, res, true);
  }
);

app.post(
  '/api/counts/:id/import-results-excel',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK, UserRole.CONTADOR),
  memoryUpload.single('file'),
  (req: AuthenticatedRequest, res) => {
    const countId = parsePositiveInt(req.params.id);
    if (!countId) {
      res.status(400).json({ error: 'Identificador de conteo inválido.' });
      return;
    }

    const countRow = db.prepare('SELECT * FROM counts WHERE id = ?').get(countId) as
      | Record<string, unknown>
      | undefined;
    if (!countRow) {
      res.status(404).json({ error: 'Conteo no encontrado.' });
      return;
    }
    if (countRow.status !== CountStatus.EJECUCION) {
      res.status(403).json({
        error: `Solo se pueden importar resultados en estado EJECUCIÓN (estado actual: ${countRow.status}).`,
      });
      return;
    }
    if (req.user!.role === UserRole.RESPONSABLE_DEPOSITO) {
      res.status(403).json({ error: 'El responsable de depósito no puede cargar resultados de conteo.' });
      return;
    }
    if (
      req.user!.role === UserRole.CONTADOR &&
      Number(countRow.assigned_counter_id) !== req.user!.id
    ) {
      res.status(403).json({ error: 'No tiene permisos para importar resultados en este conteo.' });
      return;
    }

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
          const resolvedLoose = looseVal ?? (bulkVal !== null ? 0 : null);
          matched.push({
            itemId,
            sku,
            bulkQty: bulkVal,
            looseQty: resolvedLoose,
            countedQty: (bulkVal ?? 0) + (resolvedLoose ?? 0),
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

app.post(
  '/api/counts/:id/warehouse-sign',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK, UserRole.RESPONSABLE_DEPOSITO),
  (req: AuthenticatedRequest, res) => {
  const countId = parsePositiveInt(req.params.id);
  if (!countId) {
    res.status(400).json({ error: 'Identificador de conteo inválido.' });
    return;
  }
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

  if (countRow.status !== CountStatus.EJECUCION) {
    res.status(403).json({
      error: `La firma del Responsable de Depósito solo se registra en estado EJECUCIÓN (estado actual: ${countRow.status}).`,
    });
    return;
  }

  const { signatureName, notes } = req.body as { signatureName?: string; notes?: string };
  db.prepare(
    `UPDATE counts SET
      warehouse_signature_name = ?,
      warehouse_signed_at = datetime('now'),
      warehouse_confirmed_notes = ?,
      updated_at = datetime('now')
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

function executeRejectCount(
  req: AuthenticatedRequest,
  res: express.Response
): void {
  const countId = parsePositiveInt(req.params.id);
  if (!countId) {
    res.status(400).json({ error: 'Identificador de conteo inválido.' });
    return;
  }
  const { rejectionReason, itemReasons, chiefObservations } = req.body as {
    rejectionReason?: string;
    itemReasons?: Array<{ itemId: number; reason: string }>;
    chiefObservations?: string;
  };

  const finalReason = (rejectionReason || chiefObservations || '').trim();
  if (!finalReason) {
    res.status(400).json({
      error: 'El motivo del rechazo es obligatorio para devolver el conteo al responsable asignado.',
    });
    return;
  }

  const countRow = db.prepare('SELECT * FROM counts WHERE id = ?').get(countId) as
    | Record<string, unknown>
    | undefined;
  if (!countRow) {
    res.status(404).json({ error: 'Conteo no encontrado.' });
    return;
  }
  if (countRow.status === CountStatus.APROBADO) {
    res.status(403).json({ error: 'No se puede rechazar un conteo ya aprobado.' });
    return;
  }
  if (!canTransitionCountStatus(String(countRow.status), CountStatus.RECHAZADO)) {
    res.status(400).json({
      error: `Solo se puede rechazar un conteo en estado ENTREGADO (estado actual: ${countRow.status}).`,
    });
    return;
  }

  const tx = db.transaction(() => {
    // Mark latest pending submission as RECHAZADO (preserving original submitted version)
    const latestSub = db
      .prepare(
        `SELECT id FROM count_submissions
         WHERE count_id = ? AND outcome_status = 'ENTREGADO'
         ORDER BY version_number DESC LIMIT 1`
      )
      .get(countId) as { id: number } | undefined;
    if (latestSub) {
      db.prepare(
        `UPDATE count_submissions SET
          outcome_status = 'RECHAZADO',
          reviewed_by_user_id = ?,
          reviewed_by_username = ?,
          review_notes = ?,
          reviewed_at = datetime('now')
         WHERE id = ?`
      ).run(req.user!.id, req.user!.username, finalReason, latestSub.id);
    }

    db.prepare(
      `UPDATE counts SET
        status = 'RECHAZADO',
        rejected_at = datetime('now'),
        rejected_by_user_id = ?,
        rejection_reason = ?,
        chief_notes = ?,
        updated_at = datetime('now')
       WHERE id = ?`
    ).run(req.user!.id, finalReason, finalReason, countId);

    if (Array.isArray(itemReasons)) {
      const upd = db.prepare(
        'UPDATE count_items SET recount_requested_reason = ? WHERE id = ? AND count_id = ?'
      );
      for (const r of itemReasons) {
        upd.run(String(r.reason || '').trim(), r.itemId, countId);
      }
    }

    recordCountStateTransition({
      countId,
      locationId: Number(countRow.location_id),
      previousStatus: String(countRow.status),
      newStatus: CountStatus.RECHAZADO,
      user: req.user!,
      reason: finalReason,
      metadata: { itemReasonsCount: Array.isArray(itemReasons) ? itemReasons.length : 0 },
      ipAddress: getClientIp(req),
    });

    if (countRow.assigned_counter_id) {
      createNotification({
        targetUserId: Number(countRow.assigned_counter_id),
        severity: 'ALTA',
        title: `Conteo rechazado: ${countRow.count_number}`,
        message: `Motivo: ${finalReason}`,
        entityType: 'COUNT',
        entityId: countId,
      });
    }

    logAudit({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'COUNT_REJECTED',
      entityType: 'COUNT',
      entityId: countId,
      locationId: Number(countRow.location_id),
      newValue: { rejectionReason: finalReason, itemReasons },
      ipAddress: getClientIp(req),
    });
  });

  tx();
  res.json({ ok: true, status: CountStatus.RECHAZADO });
}

app.post(
  '/api/counts/:id/reject',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK),
  executeRejectCount
);

app.post(
  '/api/counts/:id/request-recount',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK),
  executeRejectCount
);

function executeApproveCount(
  req: AuthenticatedRequest,
  res: express.Response
): void {
  const countId = parsePositiveInt(req.params.id);
  if (!countId) {
    res.status(400).json({ error: 'Identificador de conteo inválido.' });
    return;
  }
  const { approvalNotes, chiefNotes, chiefSignatureName } = req.body as {
    approvalNotes?: string;
    chiefNotes?: string;
    chiefSignatureName?: string;
  };
  const notesText = (approvalNotes ?? chiefNotes ?? '').trim();
  const signatureText = (chiefSignatureName ?? req.user!.fullName).trim();

  const countRow = db.prepare('SELECT * FROM counts WHERE id = ?').get(countId) as
    | Record<string, unknown>
    | undefined;
  if (!countRow) {
    res.status(404).json({ error: 'Conteo no encontrado.' });
    return;
  }
  if (countRow.status === CountStatus.APROBADO) {
    res.status(403).json({ error: 'El conteo ya se encuentra aprobado.' });
    return;
  }
  if (!canTransitionCountStatus(String(countRow.status), CountStatus.APROBADO)) {
    res.status(400).json({
      error: `No se puede aprobar el conteo desde el estado ${countRow.status}. Debe encontrarse en ENTREGADO.`,
    });
    return;
  }

  const latestSub = db
    .prepare(
      `SELECT id, submitted_by_user_id FROM count_submissions
       WHERE count_id = ? AND outcome_status = 'ENTREGADO'
       ORDER BY version_number DESC LIMIT 1`
    )
    .get(countId) as { id: number; submitted_by_user_id: number | null } | undefined;

  // Segregation of duties: whoever presented the count CANNOT approve it
  const presenterUserId =
    latestSub?.submitted_by_user_id ??
    (countRow.submitted_by_user_id !== null && countRow.submitted_by_user_id !== undefined
      ? Number(countRow.submitted_by_user_id)
      : null);

  if (presenterUserId !== null && Number(presenterUserId) === req.user!.id) {
    res.status(403).json({
      error:
        'Segregación de funciones: quien presentó el conteo no puede aprobarlo. Debe revisarlo y aprobarlo otro usuario con rol Jefe de Control de Stock.',
    });
    return;
  }

  const itemProdRows = db
    .prepare('SELECT product_id FROM count_items WHERE count_id = ?')
    .all(countId) as Array<{ product_id: number }>;
  const postMovements = getPostSnapshotMovementsForCount(
    countId,
    Number(countRow.location_id),
    String(countRow.created_at),
    itemProdRows.map((r) => r.product_id)
  );

  const tx = db.transaction(() => {
    if (latestSub) {
      db.prepare(
        `UPDATE count_submissions SET
          outcome_status = 'APROBADO',
          reviewed_by_user_id = ?,
          reviewed_by_username = ?,
          review_notes = ?,
          reviewed_at = datetime('now')
         WHERE id = ?`
      ).run(req.user!.id, req.user!.username, notesText, latestSub.id);
    }

    db.prepare(
      `UPDATE counts SET
        status = 'APROBADO',
        approved_at = datetime('now'),
        approved_by_user_id = ?,
        approval_notes = ?,
        validated_at = datetime('now'),
        chief_signature_name = ?,
        chief_signed_at = datetime('now'),
        chief_notes = ?,
        has_post_snapshot_movements = ?,
        updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      req.user!.id,
      notesText,
      signatureText,
      notesText,
      postMovements.length > 0 ? 1 : 0,
      countId
    );

    recordCountStateTransition({
      countId,
      locationId: Number(countRow.location_id),
      previousStatus: String(countRow.status),
      newStatus: CountStatus.APROBADO,
      user: req.user!,
      reason:
        notesText ||
        'Resultado físico aprobado por Jefatura de Control de Stock (seguimiento de regularizaciones ERP habilitado; existencias ERP no alteradas).',
      metadata: { postSnapshotMovementsCount: postMovements.length, erpStockMutated: false },
      ipAddress: getClientIp(req),
    });

    if (countRow.assigned_counter_id) {
      createNotification({
        targetUserId: Number(countRow.assigned_counter_id),
        severity: 'INFO',
        title: `Conteo aprobado: ${countRow.count_number}`,
        message: 'El Jefe de Control de Stock aprobó el relevamiento físico presentado.',
        entityType: 'COUNT',
        entityId: countId,
      });
    }

    logAudit({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'COUNT_APPROVED',
      entityType: 'COUNT',
      entityId: countId,
      locationId: Number(countRow.location_id),
      newValue: {
        approvalNotes: notesText,
        chiefSignatureName: signatureText,
        postSnapshotMovementsCount: postMovements.length,
        erpStockMutated: false,
      },
      ipAddress: getClientIp(req),
    });
  });

  tx();
  res.json({ ok: true, status: CountStatus.APROBADO });
}

app.post(
  '/api/counts/:id/approve',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK),
  executeApproveCount
);

app.post(
  '/api/counts/:id/validate',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK),
  executeApproveCount
);

app.post(
  '/api/counts/:id/items/:itemId/regularize',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK),
  (req: AuthenticatedRequest, res) => {
    const countId = parsePositiveInt(req.params.id);
    const itemId = parsePositiveInt(req.params.itemId);
    if (!countId || !itemId) {
      res.status(400).json({ error: 'Identificadores inválidos.' });
      return;
    }
    const countRow = db.prepare('SELECT * FROM counts WHERE id = ?').get(countId) as
      | Record<string, unknown>
      | undefined;
    if (!countRow) {
      res.status(404).json({ error: 'Conteo no encontrado.' });
      return;
    }
    if (countRow.status !== CountStatus.APROBADO) {
      res.status(400).json({
        error: `Solo se pueden registrar regularizaciones ERP cuando el conteo está en estado APROBADO (estado actual: ${countRow.status}).`,
      });
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

    if (
      !adjustmentStatus ||
      !Object.values(AdjustmentOperationType).includes(adjustmentStatus) ||
      adjustmentStatus === AdjustmentOperationType.PENDIENTE
    ) {
      res.status(400).json({ error: 'Tipo de operación de regularización inválido.' });
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

    const regTx = db.transaction(() => {
      db.prepare("UPDATE counts SET updated_at = datetime('now') WHERE id = ?").run(countId);

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
        newValue: {
          adjustmentStatus,
          erpOperationNumber,
          noAdjustmentReason,
          adjustmentNotes,
          erpStockMutated: false,
        },
        ipAddress: getClientIp(req),
      });
    });

    regTx();
    res.json({ ok: true, status: CountStatus.APROBADO });
  }
);

// ============================================================================
// 7. ATTACHMENTS (PHOTOS & ERP EVIDENCE DOCUMENTS)
// ============================================================================

function authorizeAttachmentEntity(
  user: AuthUser,
  entityType: string,
  entityId: number,
  mode: 'READ' | 'WRITE'
): { ok: true; locationId: number | null } | { ok: false; status: number; error: string } {
  if (mode === 'WRITE' && user.role === UserRole.AUDITORIA_DIRECCION) {
    return {
      ok: false,
      status: 403,
      error: 'El perfil Dirección / Auditoría Interna es de solo lectura y no puede cargar adjuntos.',
    };
  }

  if (entityType === 'COUNT_ITEM') {
    const item = db
      .prepare(
        `SELECT ci.id, c.location_id, c.assigned_counter_id, c.status
         FROM count_items ci
         JOIN counts c ON c.id = ci.count_id
         WHERE ci.id = ?`
      )
      .get(entityId) as
      | { id: number; location_id: number; assigned_counter_id: number; status: string }
      | undefined;
    if (!item) return { ok: false, status: 404, error: 'Ítem de conteo no encontrado.' };
    if (mode === 'WRITE' && item.status !== CountStatus.EJECUCION) {
      return {
        ok: false,
        status: 403,
        error: `Solo se pueden cargar adjuntos de ítems cuando el conteo está en EJECUCIÓN (estado actual: ${item.status}).`,
      };
    }
    if (user.role === UserRole.JEFE_STOCK) return { ok: true, locationId: item.location_id };
    if (mode === 'READ' && user.role === UserRole.AUDITORIA_DIRECCION) {
      return { ok: true, locationId: item.location_id };
    }
    if (user.role === UserRole.CONTADOR) {
      if (item.assigned_counter_id !== user.id) {
        return { ok: false, status: 403, error: 'Solo puede acceder a adjuntos de sus conteos asignados.' };
      }
      return { ok: true, locationId: item.location_id };
    }
    if (mode === 'READ' && userCanAccessLocation(user, item.location_id)) {
      return { ok: true, locationId: item.location_id };
    }
    return { ok: false, status: 403, error: 'Permisos insuficientes sobre este adjunto de conteo.' };
  }

  if (entityType === 'COUNT_SHEET' || entityType === 'ADJUSTMENT') {
    const count = db
      .prepare('SELECT id, location_id, assigned_counter_id, status FROM counts WHERE id = ?')
      .get(entityId) as
      | { id: number; location_id: number; assigned_counter_id: number; status: string }
      | undefined;
    if (!count) return { ok: false, status: 404, error: 'Conteo no encontrado.' };
    if (mode === 'WRITE') {
      if (count.status === CountStatus.RECHAZADO) {
        return {
          ok: false,
          status: 403,
          error: 'El conteo fue rechazado; debe reabrirlo a EJECUCIÓN antes de cargar nuevos adjuntos.',
        };
      }
      if (
        (user.role === UserRole.CONTADOR || user.role === UserRole.RESPONSABLE_DEPOSITO) &&
        count.status !== CountStatus.EJECUCION
      ) {
        return {
          ok: false,
          status: 403,
          error: `No se pueden cargar adjuntos en el estado actual (${count.status}).`,
        };
      }
    }
    if (user.role === UserRole.JEFE_STOCK) return { ok: true, locationId: count.location_id };
    if (mode === 'READ' && user.role === UserRole.AUDITORIA_DIRECCION) {
      return { ok: true, locationId: count.location_id };
    }
    if (entityType === 'ADJUSTMENT') {
      if (mode === 'READ' && user.role === UserRole.RESPONSABLE_DEPOSITO && userCanAccessLocation(user, count.location_id)) {
        return { ok: true, locationId: count.location_id };
      }
      return { ok: false, status: 403, error: 'Solo Control de Stock puede gestionar comprobantes ERP de ajuste.' };
    }
    // COUNT_SHEET
    if (user.role === UserRole.CONTADOR) {
      if (count.assigned_counter_id !== user.id) {
        return { ok: false, status: 403, error: 'No tiene permisos sobre esta planilla de conteo.' };
      }
      return { ok: true, locationId: count.location_id };
    }
    if (userCanAccessLocation(user, count.location_id)) {
      return { ok: true, locationId: count.location_id };
    }
    return { ok: false, status: 403, error: 'No tiene permisos sobre la ubicación de este conteo.' };
  }

  return { ok: false, status: 400, error: 'Tipo de entidad inválido.' };
}

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
    const parsedEntityId = parsePositiveInt(entityId);
    if (
      !entityType ||
      !['COUNT_ITEM', 'COUNT_SHEET', 'ADJUSTMENT'].includes(entityType) ||
      !parsedEntityId
    ) {
      fs.unlink(req.file.path, () => {});
      res.status(400).json({ error: 'Tipo y referencia de entidad requeridos.' });
      return;
    }

    const authz = authorizeAttachmentEntity(req.user!, entityType, parsedEntityId, 'WRITE');
    if (!authz.ok) {
      fs.unlink(req.file.path, () => {});
      res.status(authz.status).json({ error: authz.error });
      return;
    }

    const info = db
      .prepare(
        `INSERT INTO attachments (entity_type, entity_id, filename, original_name, mime_type, size_bytes, uploaded_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entityType,
        parsedEntityId,
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
      entityId: parsedEntityId,
      locationId: authz.locationId,
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

app.get('/api/attachments/:id', requireAuth, (req: AuthenticatedRequest, res) => {
  const attId = parsePositiveInt(req.params.id);
  if (!attId) {
    res.status(400).json({ error: 'Identificador de adjunto inválido.' });
    return;
  }

  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(attId) as
    | {
        id: number;
        entity_type: string;
        entity_id: number;
        filename: string;
        original_name: string;
        mime_type: string;
      }
    | undefined;
  if (!row) {
    res.status(404).json({ error: 'Archivo no encontrado.' });
    return;
  }

  const authz = authorizeAttachmentEntity(req.user!, row.entity_type, Number(row.entity_id), 'READ');
  if (!authz.ok) {
    res.status(authz.status).json({ error: authz.error });
    return;
  }

  const resolvedPath = path.resolve(UPLOADS_DIR, row.filename);
  if (!resolvedPath.startsWith(UPLOADS_DIR + path.sep) || !fs.existsSync(resolvedPath)) {
    res.status(404).json({ error: 'Archivo físico no disponible.' });
    return;
  }

  const safeFilename = String(row.original_name || 'archivo').replace(/[\r\n"\\]/g, '_');
  const safeInlineTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
  const isSafeInline = safeInlineTypes.has(row.mime_type);
  const contentType = ALLOWED_ATTACHMENT_MIMES.has(row.mime_type)
    ? row.mime_type
    : 'application/octet-stream';

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', contentType);
  res.setHeader(
    'Content-Disposition',
    `${isSafeInline ? 'inline' : 'attachment'}; filename="${safeFilename}"`
  );
  fs.createReadStream(resolvedPath).pipe(res);
});

// ============================================================================
// 8. EXECUTIVE DASHBOARD, AI ANALYTICS, NOTIFICATIONS, AUDIT & BACKUP
// ============================================================================

app.get(
  '/api/dashboard/executive',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK, UserRole.AUDITORIA_DIRECCION),
  (req: AuthenticatedRequest, res) => {
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
        SUM(CASE WHEN c.status = 'EJECUCION' THEN 1 ELSE 0 END) as en_ejecucion,
        SUM(CASE WHEN c.status = 'ENTREGADO' THEN 1 ELSE 0 END) as entregados,
        SUM(CASE WHEN c.status = 'RECHAZADO' THEN 1 ELSE 0 END) as rechazados,
        SUM(CASE WHEN c.status = 'APROBADO' THEN 1 ELSE 0 END) as aprobados
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
        SUM(CASE WHEN c.status IN ('ENTREGADO', 'APROBADO') THEN 1 ELSE 0 END) as completed_counts,
        (SELECT COUNT(*) FROM count_items ci2 JOIN counts c2 ON c2.id = ci2.count_id
         WHERE c2.assigned_counter_id = u.id AND ci2.final_counted_qty IS NOT NULL) as total_items_counted,
        (SELECT COUNT(*) FROM count_items ci3 JOIN counts c3 ON c3.id = ci3.count_id
         WHERE c3.assigned_counter_id = u.id AND ci3.recount_qty IS NOT NULL) as recount_items,
        ROUND(AVG(CASE WHEN c.submitted_at IS NOT NULL AND c.executed_at IS NOT NULL
          THEN (julianday(c.submitted_at) - julianday(c.executed_at)) * 24.0 ELSE NULL END), 1) as avg_hours_execution
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
        COUNT(*) as total_created,
        SUM(CASE WHEN status IN ('EJECUCION', 'RECHAZADO') THEN 1 ELSE 0 END) as active_counts,
        SUM(CASE WHEN status = 'EJECUCION' THEN 1 ELSE 0 END) as en_ejecucion,
        SUM(CASE WHEN status = 'ENTREGADO' THEN 1 ELSE 0 END) as entregados,
        SUM(CASE WHEN status = 'RECHAZADO' THEN 1 ELSE 0 END) as rechazados,
        SUM(CASE WHEN status = 'APROBADO' THEN 1 ELSE 0 END) as aprobados,
        SUM(CASE WHEN status = 'APROBADO' AND EXISTS (
          SELECT 1 FROM count_items ci_p
          WHERE ci_p.count_id = counts.id
            AND (ci_p.is_not_counted = 1 OR ci_p.reconciliation_result IN ('FALTANTE', 'SOBRANTE'))
            AND ci_p.adjustment_status = 'PENDIENTE'
        ) THEN 1 ELSE 0 END) as aprobados_pendientes_reg,
        SUM(CASE WHEN status != 'APROBADO' AND scheduled_date < date('now') THEN 1 ELSE 0 END) as overdue_counts
       FROM counts`
    )
    .get() as Record<string, number>;

  const aprobadosTotalLive = Number(liveCounts.aprobados || 0);
  const aprobadosPendientesRegLive = Number(liveCounts.aprobados_pendientes_reg || 0);
  const aprobadosRegularizadosLive = Math.max(0, aprobadosTotalLive - aprobadosPendientesRegLive);

  const activeStockUnits = (
    db.prepare('SELECT COALESCE(SUM(available_stock), 0) as units FROM inventory_balances').get() as {
      units: number;
    }
  ).units;

  const trackingAlerts: Array<{
    key: string;
    severity: 'CRITICA' | 'ALTA' | 'MEDIA';
    title: string;
    count: number;
    targetTab: 'management' | 'validation' | 'counts';
    filterStatus?: string;
  }> = [];

  if (Number(liveCounts.overdue_counts || 0) > 0) {
    trackingAlerts.push({
      key: 'overdue',
      severity: 'CRITICA',
      title: `${liveCounts.overdue_counts} conteo(s) atrasado(s) respecto a su fecha programada`,
      count: Number(liveCounts.overdue_counts || 0),
      targetTab: 'management',
    });
  }
  if (Number(liveCounts.entregados || 0) > 0) {
    trackingAlerts.push({
      key: 'pending_approval',
      severity: 'ALTA',
      title: `${liveCounts.entregados} conteo(s) entregado(s) pendiente(s) de aprobación por Control de Stock`,
      count: Number(liveCounts.entregados || 0),
      targetTab: 'validation',
      filterStatus: CountStatus.ENTREGADO,
    });
  }
  if (Number(liveCounts.rechazados || 0) > 0) {
    trackingAlerts.push({
      key: 'rejected',
      severity: 'ALTA',
      title: `${liveCounts.rechazados} conteo(s) rechazado(s) pendiente(s) de reapertura y corrección`,
      count: Number(liveCounts.rechazados || 0),
      targetTab: 'management',
      filterStatus: CountStatus.RECHAZADO,
    });
  }
  if (aprobadosPendientesRegLive > 0) {
    trackingAlerts.push({
      key: 'pending_regularization',
      severity: 'MEDIA',
      title: `${aprobadosPendientesRegLive} conteo(s) aprobado(s) con regularización ERP pendiente de documentar`,
      count: aprobadosPendientesRegLive,
      targetTab: 'validation',
      filterStatus: CountStatus.APROBADO,
    });
  }
  if (Number(liveCounts.en_ejecucion || 0) > 0) {
    trackingAlerts.push({
      key: 'pending_execution',
      severity: 'MEDIA',
      title: `${liveCounts.en_ejecucion} conteo(s) en ejecución pendiente(s) de entrega`,
      count: Number(liveCounts.en_ejecucion || 0),
      targetTab: 'management',
      filterStatus: CountStatus.EJECUCION,
    });
  }

  // Active counts grouped by Counter (Contadores) for executive supervision
  const activeScopeConds: string[] = ["c.status != 'APROBADO'"];
  const activeScopeParams: unknown[] = [];
  if (locationId) {
    activeScopeConds.push('c.location_id = ?');
    activeScopeParams.push(locationId);
  }
  if (counterId) {
    activeScopeConds.push('c.assigned_counter_id = ?');
    activeScopeParams.push(counterId);
  }
  const activeCountsRows = db
    .prepare(
      `SELECT c.id, c.count_number, c.location_id, l.name as location_name, l.group_type as location_group,
        c.assigned_counter_id, COALESCE(u.full_name, 'Sin asignar') as counter_name,
        COALESCE(u.username, '') as counter_username, COALESCE(u.role, '') as counter_role,
        c.scheduled_date, c.status, c.weekly_goal_tag,
        (SELECT COUNT(*) FROM count_items ci WHERE ci.count_id = c.id) as items_count,
        (SELECT COUNT(*) FROM count_items ci WHERE ci.count_id = c.id AND (ci.final_counted_qty IS NOT NULL OR ci.is_not_counted = 1)) as counted_items_count,
        CASE WHEN c.scheduled_date < date('now') THEN 1 ELSE 0 END as is_overdue
       FROM counts c
       JOIN locations l ON l.id = c.location_id
       LEFT JOIN users u ON u.id = c.assigned_counter_id
       WHERE ${activeScopeConds.join(' AND ')}
       ORDER BY is_overdue DESC, c.scheduled_date ASC, c.id DESC`
    )
    .all(...activeScopeParams) as Array<Record<string, unknown>>;

  const counterUsersRows = db
    .prepare(
      `SELECT id, username, full_name, role, assigned_location_ids, assigned_families
       FROM users
       WHERE is_active = 1 AND role = 'CONTADOR'
       ORDER BY full_name ASC`
    )
    .all() as Array<Record<string, unknown>>;

  const locNameMap = new Map(
    (db.prepare('SELECT id, name FROM locations').all() as Array<{ id: number; name: string }>).map((l) => [
      l.id,
      l.name,
    ])
  );

  interface CounterBucket {
    counterId: number | null;
    counterName: string;
    counterUsername: string;
    role: string;
    assignedLocationsLabel: string;
    totalActive: number;
    inExecutionCount: number;
    deliveredCount: number;
    rejectedCount: number;
    overdueCount: number;
    counts: Array<{
      id: number;
      count_number: string;
      location_name: string;
      location_group: string;
      scheduled_date: string;
      status: CountStatus;
      items_count: number;
      counted_items_count: number;
      is_overdue: boolean;
    }>;
  }

  const counterBucketsMap = new Map<string, CounterBucket>();

  for (const cu of counterUsersRows) {
    const cid = Number(cu.id);
    if (counterId && cid !== counterId) continue;
    let locIds: number[] = [];
    try {
      locIds = JSON.parse(String(cu.assigned_location_ids || '[]')).map(Number);
    } catch {
      locIds = [];
    }
    if (locationId && locIds.length > 0 && !locIds.includes(locationId)) continue;
    const assignedLocationsLabel =
      locIds.length > 0
        ? locIds.map((id) => locNameMap.get(id) || `#${id}`).join(', ')
        : 'Sin depósitos asignados';

    counterBucketsMap.set(`user:${cid}`, {
      counterId: cid,
      counterName: String(cu.full_name),
      counterUsername: String(cu.username),
      role: String(cu.role),
      assignedLocationsLabel,
      totalActive: 0,
      inExecutionCount: 0,
      deliveredCount: 0,
      rejectedCount: 0,
      overdueCount: 0,
      counts: [],
    });
  }

  for (const r of activeCountsRows) {
    const cid = r.assigned_counter_id !== null && r.assigned_counter_id !== undefined ? Number(r.assigned_counter_id) : null;
    const key = cid !== null ? `user:${cid}` : 'unassigned';
    if (!counterBucketsMap.has(key)) {
      counterBucketsMap.set(key, {
        counterId: cid,
        counterName: cid !== null ? String(r.counter_name) : 'Sin contador asignado',
        counterUsername: cid !== null ? String(r.counter_username) : '',
        role: cid !== null ? String(r.counter_role || 'JEFE_STOCK') : 'SIN_ASIGNAR',
        assignedLocationsLabel: cid !== null ? 'Supervisión / Jefatura' : 'Pendiente de asignación',
        totalActive: 0,
        inExecutionCount: 0,
        deliveredCount: 0,
        rejectedCount: 0,
        overdueCount: 0,
        counts: [],
      });
    }
    const bucket = counterBucketsMap.get(key)!;
    const st = String(r.status) as CountStatus;
    const isOverdue = Boolean(r.is_overdue);
    bucket.totalActive += 1;
    if (st === CountStatus.EJECUCION) bucket.inExecutionCount += 1;
    else if (st === CountStatus.ENTREGADO) bucket.deliveredCount += 1;
    else if (st === CountStatus.RECHAZADO) bucket.rejectedCount += 1;
    if (isOverdue) bucket.overdueCount += 1;

    bucket.counts.push({
      id: Number(r.id),
      count_number: String(r.count_number),
      location_name: String(r.location_name),
      location_group: String(r.location_group),
      scheduled_date: String(r.scheduled_date),
      status: st,
      items_count: Number(r.items_count || 0),
      counted_items_count: Number(r.counted_items_count || 0),
      is_overdue: isOverdue,
    });
  }

  const activeCountsByCounter = Array.from(counterBucketsMap.values()).sort(
    (a, b) => b.totalActive - a.totalActive || a.counterName.localeCompare(b.counterName, 'es')
  );

  // Planned counts pending approval within the current calendar month
  const monthlyConds: string[] = [
    "c.status != 'APROBADO'",
    "strftime('%Y-%m', c.scheduled_date) = strftime('%Y-%m', 'now')",
  ];
  const monthlyParams: unknown[] = [];
  if (locationId) {
    monthlyConds.push('c.location_id = ?');
    monthlyParams.push(locationId);
  }
  if (counterId) {
    monthlyConds.push('c.assigned_counter_id = ?');
    monthlyParams.push(counterId);
  }

  const monthlyPendingCounts = db
    .prepare(
      `SELECT c.id, c.count_number, c.location_id, l.name as location_name, l.group_type as location_group,
        c.assigned_counter_id, COALESCE(u.full_name, 'Sin asignar') as counter_name,
        c.scheduled_date, c.status, c.weekly_goal_tag,
        (SELECT COUNT(*) FROM count_items ci WHERE ci.count_id = c.id) as items_count,
        (SELECT COUNT(*) FROM count_items ci WHERE ci.count_id = c.id AND (ci.final_counted_qty IS NOT NULL OR ci.is_not_counted = 1)) as counted_items_count,
        CASE WHEN c.scheduled_date < date('now') THEN 1 ELSE 0 END as is_overdue
       FROM counts c
       JOIN locations l ON l.id = c.location_id
       LEFT JOIN users u ON u.id = c.assigned_counter_id
       WHERE ${monthlyConds.join(' AND ')}
       ORDER BY is_overdue DESC, c.scheduled_date ASC, c.id DESC`
    )
    .all(...monthlyParams);

  // Approved counts & ERP regularization tracking
  const approvedConds: string[] = ["c.status = 'APROBADO'", ...countConds];
  const approvedParams: unknown[] = [...countParams];
  if (skuFilter) {
    approvedConds.push(
      'EXISTS (SELECT 1 FROM count_items ci_f JOIN products p_f ON p_f.id = ci_f.product_id WHERE ci_f.count_id = c.id AND p_f.sku LIKE ?)'
    );
    approvedParams.push(`%${skuFilter}%`);
  }

  const closedCounts = db
    .prepare(
      `SELECT c.id, c.count_number, l.name as location_name, l.group_type as location_group,
        COALESCE(uc.full_name, 'Sin asignar') as counter_name,
        c.scheduled_date, COALESCE(c.approved_at, c.validated_at, c.closed_at) as approved_at, c.chief_signature_name,
        COALESCE(ua.full_name, c.chief_signature_name, 'Jefatura') as approved_by_name,
        CASE WHEN strftime('%Y-%m', COALESCE(c.approved_at, c.validated_at, c.closed_at, c.scheduled_date)) = strftime('%Y-%m', 'now') THEN 1 ELSE 0 END as is_current_month,
        (SELECT COUNT(*) FROM count_items ci WHERE ci.count_id = c.id) as items_count,
        (SELECT COUNT(*) FROM count_items ci WHERE ci.count_id = c.id AND ci.reconciliation_result = 'COINCIDENCIA') as matches_count,
        (SELECT COUNT(*) FROM count_items ci WHERE ci.count_id = c.id AND ci.reconciliation_result IN ('FALTANTE', 'SOBRANTE')) as discrepancies_count,
        (SELECT COUNT(*) FROM count_items ci WHERE ci.count_id = c.id AND (ci.is_not_counted = 1 OR ci.reconciliation_result IN ('FALTANTE', 'SOBRANTE')) AND ci.adjustment_status = 'PENDIENTE') as pending_reg_items_count,
        (SELECT COUNT(*) FROM count_items ci WHERE ci.count_id = c.id AND ci.adjustment_status IN ('AJUSTE', 'MOVIMIENTO')) as adjusted_items_count,
        (SELECT COUNT(*) FROM count_items ci WHERE ci.count_id = c.id AND ci.adjustment_status = 'SIN_AJUSTE') as no_adjustment_items_count,
        COALESCE((SELECT SUM(CASE WHEN ci.reconciliation_result IN ('FALTANTE', 'SOBRANTE') AND ci.snapshot_cost_price IS NOT NULL THEN ci.difference * ci.snapshot_cost_price ELSE 0 END) FROM count_items ci WHERE ci.count_id = c.id), 0) as net_economic_diff,
        COALESCE((SELECT SUM(CASE WHEN ci.reconciliation_result IN ('FALTANTE', 'SOBRANTE') AND ci.snapshot_cost_price IS NOT NULL THEN ABS(ci.difference) * ci.snapshot_cost_price ELSE 0 END) FROM count_items ci WHERE ci.count_id = c.id), 0) as abs_economic_diff
       FROM counts c
       JOIN locations l ON l.id = c.location_id
       LEFT JOIN users uc ON uc.id = c.assigned_counter_id
       LEFT JOIN users ua ON ua.id = COALESCE(c.approved_by_user_id, c.closed_by_user_id)
       WHERE ${approvedConds.join(' AND ')}
       ORDER BY COALESCE(c.approved_at, c.validated_at, c.closed_at, c.updated_at, c.created_at) DESC, c.id DESC
       LIMIT 50`
    )
    .all(...approvedParams);

  const monthlyApprovedRow = db
    .prepare(
      `SELECT COUNT(*) as cnt
       FROM counts c
       WHERE ${approvedConds.join(' AND ')}
         AND strftime('%Y-%m', COALESCE(c.approved_at, c.validated_at, c.closed_at, c.scheduled_date)) = strftime('%Y-%m', 'now')`
    )
    .get(...approvedParams) as { cnt: number };

  const currentMonth = new Date().toISOString().slice(0, 7);

  res.json({
    quickMetrics: {
      activeInventoryCounts: Number(liveCounts.active_counts || 0),
      enEjecucion: Number(liveCounts.en_ejecucion || 0),
      entregados: Number(liveCounts.entregados || 0),
      rechazados: Number(liveCounts.rechazados || 0),
      aprobados: aprobadosTotalLive,
      aprobadosPendientesReg: aprobadosPendientesRegLive,
      aprobadosRegularizados: aprobadosRegularizadosLive,
      activeStockUnits: Number(activeStockUnits || 0),
      monthlyApprovedCounts: Number(monthlyApprovedRow.cnt || 0),
    },
    workflowSummary: {
      totalCreated: Number(liveCounts.total_created || 0),
      enEjecucion: Number(liveCounts.en_ejecucion || 0),
      entregados: Number(liveCounts.entregados || 0),
      rechazados: Number(liveCounts.rechazados || 0),
      aprobados: aprobadosTotalLive,
      aprobadosPendientesReg: aprobadosPendientesRegLive,
      aprobadosRegularizados: aprobadosRegularizadosLive,
      overdueCounts: Number(liveCounts.overdue_counts || 0),
    },
    trackingAlerts,
    currentMonth,
    activeCountsByCounter,
    monthlyPendingCounts,
    closedCounts,
    general: {
      totalProducts,
      totalLocations,
      total_counts: Number(countStats.total_counts || 0),
      en_ejecucion: Number(countStats.en_ejecucion || 0),
      entregados: Number(countStats.entregados || 0),
      rechazados: Number(countStats.rechazados || 0),
      aprobados: Number(countStats.aprobados || 0),
      compliancePct:
        countStats.total_counts > 0
          ? Math.round(((countStats.aprobados || 0) / countStats.total_counts) * 1000) / 10
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
  const notifId = parsePositiveInt(req.params.id);
  if (!notifId) {
    res.status(400).json({ error: 'Identificador de notificación inválido.' });
    return;
  }
  db.prepare(
    'UPDATE notifications SET is_read = 1 WHERE id = ? AND (target_user_id = ? OR target_role = ?)'
  ).run(notifId, req.user!.id, req.user!.role);
  res.json({ ok: true });
});

app.post('/api/notifications/read-all', requireAuth, (req: AuthenticatedRequest, res) => {
  db.prepare(
    'UPDATE notifications SET is_read = 1 WHERE target_user_id = ? OR target_role = ?'
  ).run(req.user!.id, req.user!.role);
  res.json({ ok: true });
});

app.get(
  '/api/audit',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK, UserRole.AUDITORIA_DIRECCION),
  (req, res) => {
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

const BACKUP_TABLES_ORDER = [
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
  'count_state_history',
  'count_submissions',
  'attachments',
  'notifications',
  'audit_events',
] as const;

interface BackupAttachmentFile {
  attachmentId: number;
  filename: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  contentBase64: string;
}

interface BackupPayload {
  backupVersion: number;
  exportedAt: string;
  exportedBy: string;
  walConsistentSnapshot: boolean;
  storageDiagnostics?: ReturnType<typeof getStorageDiagnostics>;
  tables: Record<string, Array<Record<string, unknown>>>;
  attachmentFiles: BackupAttachmentFile[];
  integrity: {
    algorithm: 'sha256';
    tableRowCounts: Record<string, number>;
    attachmentFilesCount: number;
    missingAttachments: Array<{ id: number; filename: string; originalName: string }>;
    checksumSha256: string;
  };
}

function computeBackupChecksum(
  tables: Record<string, Array<Record<string, unknown>>>,
  attachmentFiles: BackupAttachmentFile[]
): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ tables, attachmentFiles }))
    .digest('hex');
}

function verifyBackupStructure(raw: unknown): {
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
    tableRowCounts: Record<string, number>;
  } | null;
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['Formato JSON de respaldo inválido.'], warnings, summary: null };
  }

  const obj = raw as Partial<BackupPayload>;
  if (!obj.tables || typeof obj.tables !== 'object') {
    errors.push('Falta la sección "tables" en el respaldo.');
  }
  if (!Array.isArray(obj.attachmentFiles)) {
    errors.push('Falta la sección "attachmentFiles" en el respaldo.');
  }
  if (!obj.integrity || typeof obj.integrity.checksumSha256 !== 'string') {
    errors.push('Falta el manifiesto de integridad SHA-256.');
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings, summary: null };
  }

  const tables = obj.tables as Record<string, Array<Record<string, unknown>>>;
  const attachmentFiles = obj.attachmentFiles as BackupAttachmentFile[];

  for (const t of BACKUP_TABLES_ORDER) {
    if (!Array.isArray(tables[t])) {
      errors.push(`Falta la tabla obligatoria "${t}" o no es un arreglo.`);
    }
  }

  // Ensure no secrets or password hashes leaked into backup payload
  const usersRows = Array.isArray(tables.users) ? tables.users : [];
  for (const u of usersRows) {
    if ('password_hash' in u) {
      errors.push('El archivo contiene password_hash; se rechaza por política de seguridad.');
      break;
    }
  }

  let checksumMatch = false;
  if (errors.length === 0) {
    const expected = computeBackupChecksum(tables, attachmentFiles);
    checksumMatch = expected === obj.integrity!.checksumSha256;
    if (!checksumMatch) {
      errors.push('La firma SHA-256 del respaldo no coincide (archivo alterado o corrupto).');
    }
  }

  for (const af of attachmentFiles) {
    if (!af.filename || typeof af.contentBase64 !== 'string' || typeof af.sha256 !== 'string') {
      errors.push(`Archivo adjunto malformado en el respaldo (${af.filename || 'sin nombre'}).`);
      continue;
    }
    const safeName = path.basename(af.filename);
    if (safeName !== af.filename || af.filename.includes('..')) {
      errors.push(`Nombre de archivo adjunto inseguro en respaldo: ${af.filename}`);
      continue;
    }
    const buf = Buffer.from(af.contentBase64, 'base64');
    const actualHash = crypto.createHash('sha256').update(buf).digest('hex');
    if (actualHash !== af.sha256) {
      errors.push(`Checksum SHA-256 inválido en adjunto "${af.originalName || af.filename}".`);
    }
  }

  if (obj.integrity?.missingAttachments && obj.integrity.missingAttachments.length > 0) {
    warnings.push(
      `Al momento de exportar faltaban ${obj.integrity.missingAttachments.length} archivo(s) físico(s) en disco.`
    );
  }
  if ('pos_operations' in tables || 'pos_operation_items' in tables) {
    warnings.push(
      'El respaldo proviene de una versión anterior con tablas POS legadas; dichas tablas serán omitidas al restaurar.'
    );
  }

  const tableRowCounts: Record<string, number> = {};
  let totalRows = 0;
  for (const t of BACKUP_TABLES_ORDER) {
    const cnt = Array.isArray(tables[t]) ? tables[t].length : 0;
    tableRowCounts[t] = cnt;
    totalRows += cnt;
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary: {
      backupVersion: Number(obj.backupVersion || 1),
      exportedAt: String(obj.exportedAt || ''),
      totalTables: BACKUP_TABLES_ORDER.length,
      totalRows,
      attachmentFilesCount: attachmentFiles.length,
      checksumMatch,
      tableRowCounts,
    },
  };
}

app.get(
  '/api/admin/backup',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK),
  async (req: AuthenticatedRequest, res, next) => {
    const tempSnapshotPath = path.join(
      os.tmpdir(),
      `sicep-backup-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`
    );

    try {
      // Atomic WAL-consistent SQLite hot backup snapshot
      await db.backup(tempSnapshotPath);

      const snapDb = new Database(tempSnapshotPath, { readonly: true });
      const tablesData: Record<string, Array<Record<string, unknown>>> = {};
      const tableRowCounts: Record<string, number> = {};

      try {
        for (const t of BACKUP_TABLES_ORDER) {
          const rows =
            t === 'users'
              ? (snapDb
                  .prepare(
                    'SELECT id, username, full_name, email, role, assigned_location_ids, assigned_families, token_version, password_changed_at, is_active, last_login_at, created_at, updated_at FROM users ORDER BY id ASC'
                  )
                  .all() as Array<Record<string, unknown>>)
              : (snapDb.prepare(`SELECT * FROM ${t} ORDER BY id ASC`).all() as Array<
                  Record<string, unknown>
                >);
          tablesData[t] = rows;
          tableRowCounts[t] = rows.length;
        }
      } finally {
        snapDb.close();
      }

      const attachmentFiles: BackupAttachmentFile[] = [];
      const missingAttachments: Array<{ id: number; filename: string; originalName: string }> = [];
      const attachmentRows = tablesData.attachments || [];

      for (const att of attachmentRows) {
        const filename = String(att.filename || '');
        const resolved = path.resolve(UPLOADS_DIR, filename);
        if (!filename || !resolved.startsWith(UPLOADS_DIR + path.sep) || !fs.existsSync(resolved)) {
          missingAttachments.push({
            id: Number(att.id),
            filename,
            originalName: String(att.original_name || ''),
          });
          continue;
        }
        const buf = fs.readFileSync(resolved);
        attachmentFiles.push({
          attachmentId: Number(att.id),
          filename,
          originalName: String(att.original_name || filename),
          mimeType: String(att.mime_type || 'application/octet-stream'),
          sizeBytes: buf.length,
          sha256: crypto.createHash('sha256').update(buf).digest('hex'),
          contentBase64: buf.toString('base64'),
        });
      }

      const checksumSha256 = computeBackupChecksum(tablesData, attachmentFiles);
      const dump: BackupPayload = {
        backupVersion: 2,
        exportedAt: new Date().toISOString(),
        exportedBy: req.user!.username,
        walConsistentSnapshot: true,
        storageDiagnostics: getStorageDiagnostics(),
        tables: tablesData,
        attachmentFiles,
        integrity: {
          algorithm: 'sha256',
          tableRowCounts,
          attachmentFilesCount: attachmentFiles.length,
          missingAttachments,
          checksumSha256,
        },
      };

      logAudit({
        userId: req.user!.id,
        username: req.user!.username,
        action: 'DATABASE_BACKUP_EXPORTED',
        entityType: 'SYSTEM',
        newValue: {
          backupVersion: 2,
          tableRowCounts,
          attachmentFilesCount: attachmentFiles.length,
          missingAttachmentsCount: missingAttachments.length,
          checksumSha256,
        },
        ipAddress: getClientIp(req),
      });

      res.setHeader('Content-Type', 'application/json');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="SICEP_Respaldo_${new Date().toISOString().slice(0, 10)}.json"`
      );
      res.send(JSON.stringify(dump, null, 2));
    } catch (err) {
      next(err);
    } finally {
      for (const suffix of ['', '-wal', '-shm']) {
        const p = `${tempSnapshotPath}${suffix}`;
        if (fs.existsSync(p)) {
          try {
            fs.unlinkSync(p);
          } catch {
            // ignore cleanup errors
          }
        }
      }
    }
  }
);

app.post(
  '/api/admin/backup/verify',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK),
  (req: AuthenticatedRequest, res) => {
    const check = verifyBackupStructure(req.body);
    res.status(check.valid ? 200 : 400).json(check);
  }
);

app.post(
  '/api/admin/restore',
  requireAuth,
  requireRole(UserRole.JEFE_STOCK),
  (req: AuthenticatedRequest, res) => {
    const { backup, confirmRestore } = req.body as {
      backup?: BackupPayload;
      confirmRestore?: boolean;
    };

    if (!confirmRestore) {
      res.status(400).json({ error: 'Debe confirmar explícitamente la restauración del respaldo.' });
      return;
    }

    const check = verifyBackupStructure(backup);
    if (!check.valid || !backup) {
      res.status(400).json({
        error: check.errors[0] || 'El respaldo no superó la verificación de integridad.',
        errors: check.errors,
        warnings: check.warnings,
      });
      return;
    }

    // Preserve local password hashes by username (backup intentionally never stores hashes)
    const existingHashes = new Map<string, string>();
    const existingUsers = db
      .prepare('SELECT username, password_hash FROM users')
      .all() as Array<{ username: string; password_hash: string }>;
    for (const eu of existingUsers) {
      existingHashes.set(eu.username.trim().toLowerCase(), eu.password_hash);
    }

    const usersRequiringPasswordReset: string[] = [];

    // Restore attachment physical files safely before DB swap
    if (!fs.existsSync(UPLOADS_DIR)) {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
    for (const af of backup.attachmentFiles) {
      const targetPath = path.resolve(UPLOADS_DIR, path.basename(af.filename));
      if (!targetPath.startsWith(UPLOADS_DIR + path.sep)) {
        res.status(400).json({ error: `Ruta de adjunto inválida: ${af.filename}` });
        return;
      }
      fs.writeFileSync(targetPath, Buffer.from(af.contentBase64, 'base64'));
    }

    const tableColumnsCache = new Map<string, Set<string>>();
    const getTableColumns = (table: string): Set<string> => {
      const cached = tableColumnsCache.get(table);
      if (cached) return cached;
      const cols = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
          (c) => c.name
        )
      );
      tableColumnsCache.set(table, cols);
      return cols;
    };

    const insertRow = (table: string, row: Record<string, unknown>): void => {
      const allowedCols = getTableColumns(table);
      const cols = Object.keys(row).filter((c) => allowedCols.has(c));
      if (cols.length === 0) return;
      const placeholders = cols.map(() => '?').join(',');
      db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`).run(
        ...cols.map((c) => row[c])
      );
    };

    db.pragma('foreign_keys = OFF');
    try {
      const restoreTx = db.transaction(() => {
        for (const t of [...BACKUP_TABLES_ORDER].reverse()) {
          db.prepare(`DELETE FROM ${t}`).run();
        }
        db.prepare('DELETE FROM sqlite_sequence').run();

        const mapLegacyRestoredStatus = (rawSt: unknown): string => {
          const st = String(rawSt || '').trim().toUpperCase();
          if (st === 'PENDIENTE_APROBACION' || st === 'ENVIADO_REVISION' || st === 'ENTREGADO') {
            return CountStatus.ENTREGADO;
          }
          if (st === 'RECHAZADO' || st === 'RECONTEO_SOLICITADO') {
            return CountStatus.RECHAZADO;
          }
          if (
            st === 'APROBADO' ||
            st === 'PENDIENTE_REGULARIZACION' ||
            st === 'CERRADO' ||
            st === 'VALIDADO'
          ) {
            return CountStatus.APROBADO;
          }
          return CountStatus.EJECUCION;
        };

        for (const t of BACKUP_TABLES_ORDER) {
          const rows = backup.tables[t] || [];
          for (const rawRow of rows) {
            if (t === 'users') {
              const uname = String(rawRow.username || '').trim().toLowerCase();
              const preservedHash = existingHashes.get(uname);
              let pwHash = preservedHash;
              if (!pwHash) {
                pwHash = hashPassword(crypto.randomBytes(24).toString('hex'));
                usersRequiringPasswordReset.push(uname);
              }
              const restoredUserRow: Record<string, unknown> = {
                ...rawRow,
                password_hash: pwHash,
                token_version: Number(rawRow.token_version ?? 1) + 1,
              };
              insertRow('users', restoredUserRow);
            } else if (t === 'counts') {
              insertRow('counts', {
                ...rawRow,
                status: mapLegacyRestoredStatus(rawRow.status),
              });
            } else if (t === 'count_submissions') {
              insertRow('count_submissions', {
                ...rawRow,
                outcome_status: mapLegacyRestoredStatus(rawRow.outcome_status),
              });
            } else {
              insertRow(t, rawRow);
            }
          }
        }
      });

      restoreTx();

      const fkViolations = db.pragma('foreign_key_check') as Array<unknown>;
      if (fkViolations.length > 0) {
        throw new Error(`Violación de integridad referencial tras restaurar (${fkViolations.length} fila(s)).`);
      }

      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.pragma('foreign_keys = ON');
    }

    logAudit({
      userId: req.user!.id,
      username: req.user!.username,
      action: 'DATABASE_BACKUP_RESTORED',
      entityType: 'SYSTEM',
      newValue: {
        backupVersion: backup.backupVersion,
        exportedAt: backup.exportedAt,
        restoredChecksum: backup.integrity.checksumSha256,
        usersRequiringPasswordReset,
      },
      ipAddress: getClientIp(req),
    });

    res.json({
      ok: true,
      restoredTables: BACKUP_TABLES_ORDER.length,
      restoredRows: check.summary?.totalRows || 0,
      restoredAttachmentFiles: backup.attachmentFiles.length,
      usersRequiringPasswordReset,
      sessionRevoked: true,
    });
  }
);

app.all('/api/*', (_req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado.' });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const errObj = err as { code?: string; message?: string; status?: number };
  if (errObj?.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ error: 'El archivo supera el tamaño máximo permitido.' });
    return;
  }
  const status = typeof errObj?.status === 'number' && errObj.status >= 400 ? errObj.status : 400;
  res.status(status).json({
    error: errObj?.message || 'Error al procesar la solicitud.',
  });
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
