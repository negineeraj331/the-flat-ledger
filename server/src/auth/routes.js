// ============================================================================
// auth/routes.js — register, login, logout, "who am I".
// ============================================================================
// Passwords are hashed with bcrypt. The session is a JWT stored in an httpOnly
// cookie (so JS can't read it) and also returned in the body for non-browser
// clients. This is the "Login module" requirement.
// ============================================================================
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../../db/pool.js';
import { signToken, requireAuth } from './middleware.js';
import { config } from '../config.js';

export const authRouter = Router();

function setCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: config.isProd ? 'none' : 'lax',
    secure: config.isProd,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

authRouter.post('/register', async (req, res) => {
  const { email, password, displayName } = req.body || {};
  if (!email || !password || !displayName) {
    return res.status(400).json({ error: 'email, password, displayName are required' });
  }
  const existing = await queryOne(`SELECT id FROM users WHERE email = $1`, [email.toLowerCase()]);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const hash = await bcrypt.hash(password, 10);
  const user = await queryOne(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1,$2,$3) RETURNING id, email, display_name`,
    [email.toLowerCase(), hash, displayName]
  );
  const token = signToken(user);
  setCookie(res, token);
  res.status(201).json({ user, token });
});

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const user = await queryOne(
    `SELECT id, email, display_name, password_hash FROM users WHERE email = $1`,
    [email.toLowerCase()]
  );
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const safe = { id: user.id, email: user.email, display_name: user.display_name };
  const token = signToken(safe);
  setCookie(res, token);
  res.json({ user: safe, token });
});

authRouter.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const groups = await query(
    `SELECT g.id, g.name, g.base_currency, gu.role
     FROM groups g JOIN group_users gu ON gu.group_id = g.id
     WHERE gu.user_id = $1 ORDER BY g.id`,
    [req.user.uid]
  );
  res.json({ user: { id: req.user.uid, email: req.user.email, name: req.user.name }, groups });
});
