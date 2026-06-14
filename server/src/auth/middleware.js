// ============================================================================
// auth/middleware.js — JWT verification + group-access guard.
// ============================================================================
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { queryOne } from '../../db/pool.js';

/** Sign a short-lived token for a user. */
export function signToken(user) {
  return jwt.sign(
    { uid: user.id, email: user.email, name: user.display_name },
    config.jwtSecret,
    { expiresIn: '7d' }
  );
}

/**
 * requireAuth — reads the token from the httpOnly cookie (browser) or the
 * Authorization: Bearer header (API clients), verifies it, and attaches
 * req.user. Responds 401 if missing/invalid.
 */
export function requireAuth(req, res, next) {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const token = req.cookies?.token || bearer;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

/**
 * requireGroupAccess — ensures the authenticated user belongs to the group in
 * req.params.groupId. Attaches req.group. Use after requireAuth.
 */
export async function requireGroupAccess(req, res, next) {
  const groupId = Number(req.params.groupId);
  if (!Number.isInteger(groupId)) {
    return res.status(400).json({ error: 'Invalid group id' });
  }
  const row = await queryOne(
    `SELECT g.id, g.name, g.base_currency, gu.role
     FROM groups g
     JOIN group_users gu ON gu.group_id = g.id
     WHERE g.id = $1 AND gu.user_id = $2`,
    [groupId, req.user.uid]
  );
  if (!row) return res.status(403).json({ error: 'No access to this group' });
  req.group = row;
  next();
}
