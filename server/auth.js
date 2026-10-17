// Email + password accounts with httpOnly session cookies.
import crypto from 'node:crypto';
import { config } from './config.js';
import { one, run, newId, now } from './db.js';

const COOKIE = 'cb_session';
const SESSION_DAYS = 30;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [, saltB64, hashB64] = stored.split('$');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), 64, { N: 16384 });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = now() + SESSION_DAYS * 86400_000;
  run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)', token, userId, expires);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${config.cookieSecure ? '; Secure' : ''}`);
}

export function endSession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Attaches req.user when a valid session cookie is present.
export function loadUser(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const row = one(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token = ? AND s.expires_at > ? AND u.disabled = 0`, token, now());
    if (row) req.user = row;
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in.' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admins only.' });
  next();
}

export function createUser({ email, name, password, timezone }) {
  const id = newId('u_');
  const isAdmin = config.adminEmails.includes(email) || !one('SELECT 1 FROM users LIMIT 1') ? 1 : 0; // first user is admin
  run(`INSERT INTO users (id, email, name, password_hash, is_admin, timezone, created_at) VALUES (?,?,?,?,?,?,?)`,
    id, email, name, hashPassword(password), isAdmin, timezone || 'UTC', now());
  return one('SELECT * FROM users WHERE id = ?', id);
}

// Very small in-memory rate limiter for login/signup.
const hits = new Map();
export function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const t = now();
    const arr = (hits.get(key) || []).filter(x => t - x < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    arr.push(t); hits.set(key, arr); next();
  };
}
