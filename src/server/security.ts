import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { type AuthUser, UserRole } from '../types/erp.ts';
import { db } from './db.ts';

const EPHEMERAL_DEV_SECRET = crypto.randomBytes(32).toString('hex');
const MIN_PRODUCTION_SECRET_LEN = 32;

export function validateSecurityConfig(): void {
  const isProd = process.env.NODE_ENV === 'production';
  const envSecret = (process.env.SESSION_SECRET || '').trim();
  if (isProd) {
    if (!envSecret || envSecret.length < MIN_PRODUCTION_SECRET_LEN) {
      throw new Error(
        `FATAL: SESSION_SECRET es obligatorio en producción (mínimo ${MIN_PRODUCTION_SECRET_LEN} caracteres). No se permite iniciar con un secreto efímero.`
      );
    }
  }
}

function getSigningSecret(): string {
  const envSecret = (process.env.SESSION_SECRET || '').trim();
  if (process.env.NODE_ENV === 'production') {
    if (!envSecret || envSecret.length < MIN_PRODUCTION_SECRET_LEN) {
      throw new Error(
        `SESSION_SECRET no configurado o insuficiente en producción (mínimo ${MIN_PRODUCTION_SECRET_LEN} caracteres).`
      );
    }
    return envSecret;
  }
  return envSecret || EPHEMERAL_DEV_SECRET;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, hashHex] = parts;
  if (!salt || !hashHex) return false;
  try {
    const derived = crypto.scryptSync(password, salt, 64);
    const storedBuf = Buffer.from(hashHex, 'hex');
    if (derived.length !== storedBuf.length) return false;
    return crypto.timingSafeEqual(derived, storedBuf);
  } catch {
    return false;
  }
}

interface TokenPayload {
  uid: number;
  username: string;
  role: UserRole;
  tv: number;
  iat: number;
  exp: number;
}

export function createSessionToken(user: AuthUser, tokenVersion = 1): string {
  const now = Date.now();
  const payload: TokenPayload = {
    uid: user.id,
    username: user.username,
    role: user.role,
    tv: Number.isFinite(tokenVersion) && tokenVersion >= 1 ? tokenVersion : 1,
    iat: now,
    exp: now + 1000 * 60 * 60 * 12, // 12h session
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(data)
    .digest('base64url');
  return `${data}.${sig}`;
}

export function verifySessionToken(token: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(data)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as TokenPayload;
    if (!parsed.uid || !parsed.exp || Date.now() > parsed.exp) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function revokeUserTokens(userId: number): void {
  db.prepare('UPDATE users SET token_version = COALESCE(token_version, 1) + 1 WHERE id = ?').run(
    userId
  );
}

export function parsePositiveInt(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

export function mapDbUser(row: Record<string, unknown>): AuthUser {
  let assigned: number[] = [];
  try {
    assigned = JSON.parse(String(row.assigned_location_ids || '[]'));
  } catch {
    assigned = [];
  }
  let families: string[] = [];
  try {
    families = JSON.parse(String(row.assigned_families || '[]'));
  } catch {
    families = [];
  }
  return {
    id: Number(row.id),
    username: String(row.username),
    fullName: String(row.full_name),
    email: String(row.email || ''),
    role: row.role as UserRole,
    assignedLocationIds: Array.isArray(assigned) ? assigned.map(Number) : [],
    assignedFamilies: Array.isArray(families)
      ? families.map((f) => String(f).trim()).filter(Boolean)
      : [],
    isActive: Boolean(row.is_active),
    lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
  };
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Sesión requerida. Inicie sesión con su usuario y contraseña.' });
    return;
  }
  const token = authHeader.slice(7).trim();
  const payload = verifySessionToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Sesión inválida o expirada. Vuelva a iniciar sesión.' });
    return;
  }

  const row = db
    .prepare(
      'SELECT id, username, full_name, email, role, assigned_location_ids, assigned_families, token_version, is_active, last_login_at FROM users WHERE id = ?'
    )
    .get(payload.uid) as Record<string, unknown> | undefined;

  if (!row || !row.is_active) {
    res.status(403).json({ error: 'Usuario deshabilitado o inexistente.' });
    return;
  }

  const currentTv = Number(row.token_version ?? 1);
  if (Number(payload.tv ?? 1) !== currentTv || payload.role !== row.role) {
    res.status(401).json({
      error: 'Sesión revocada por cambio de credenciales o permisos. Vuelva a iniciar sesión.',
    });
    return;
  }

  req.user = mapDbUser(row);
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'No autenticado.' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Permisos insuficientes para ejecutar esta operación.' });
      return;
    }
    next();
  };
}

export function userCanAccessLocation(user: AuthUser, locationId: number): boolean {
  if (user.role === UserRole.JEFE_STOCK || user.role === UserRole.AUDITORIA_DIRECCION) return true;
  if (user.assignedLocationIds.length === 0) return false;
  return user.assignedLocationIds.includes(locationId);
}
