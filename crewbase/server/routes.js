import express from 'express';
import path from 'node:path';
import { config, MODEL_PRICES } from './config.js';
import { db, one, all, run, newId, now, userSpendThisMonth, userLimit, monthStart } from './db.js';
import { requireUser, requireAdmin, startSession, endSession, createUser, verifyPassword, rateLimit } from './auth.js';
import { enqueueRun, stopRun, priceOf } from './runner.js';
import { computerFor, destroyComputer } from './sandbox.js';
import { nextRunAt, describeSchedule, parseSchedule, validTimezone } from './schedule.js';
import { draftAgent } from './llm.js';

export const api = express.Router();
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const str = (v, max) => String(v ?? '').trim().slice(0, max);

// ---------- helpers ----------
function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, timezone: u.timezone, isAdmin: !!u.is_admin,
    usage: { spentUsd: userSpendThisMonth(u.id), limitUsd: userLimit(u) },
  };
}

function publicAgent(a) {
  const last = one(`SELECT id, status, trigger, cost_usd, created_at, finished_at FROM runs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1`, a.id);
  const lastText = one(`SELECT data_json FROM events WHERE agent_id = ? AND type IN ('text','notify') ORDER BY id DESC LIMIT 1`, a.id);
  const spent = one('SELECT COALESCE(SUM(cost_usd),0) AS c, COUNT(*) AS n FROM runs WHERE agent_id = ? AND created_at >= ?', a.id, monthStart());
  return {
    id: a.id, name: a.name, role: a.role, emoji: a.emoji, color: a.color, model: a.model,
    schedule: { type: a.schedule_type, value: parseSchedule(a.schedule_type, a.schedule_value), task: a.schedule_task, label: describeSchedule(a.schedule_type, a.schedule_value), nextRunAt: a.next_run_at },
    memory: a.memory, webhookUrl: a.webhook_url, status: a.status, hasComputer: !!a.sandbox_id || config.sandboxProvider === 'local',
    lastRun: last || null, lastMessage: lastText ? JSON.parse(lastText.data_json).text || JSON.parse(lastText.data_json).message : '',
    monthCostUsd: spent.c, monthRuns: spent.n, createdAt: a.created_at,
  };
}

function ownAgent(req, res) {
  const a = one('SELECT * FROM agents WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
  if (!a) { bad(res, 'Agent not found.', 404); return null; }
  return a;
}

function checkCredit(req, res) {
  const limit = userLimit(req.user);
  if (userSpendThisMonth(req.user.id) >= limit) { bad(res, `You've used your $${limit.toFixed(2)} monthly credit. It resets on the 1st.`, 402); return false; }
  return true;
}

// Validates and normalises agent fields from the request body.
function agentFields(body, existing, tz) {
  const out = {};
  if (body.name !== undefined || !existing) out.name = str(body.name, 40) || 'New agent';
  if (body.role !== undefined || !existing) {
    out.role = str(body.role, 6000);
    if (out.role.length < 10) throw new Error('Describe what the agent should do (at least a sentence).');
  }
  if (body.emoji !== undefined) out.emoji = str(body.emoji, 8) || '🤖';
  if (body.color !== undefined) out.color = /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : '#6d5efc';
  if (body.model !== undefined || !existing) out.model = config.allowedModels.includes(body.model) ? body.model : config.defaultModel;
  if (body.webhookUrl !== undefined) {
    const w = str(body.webhookUrl, 500);
    if (w && !/^https:\/\//.test(w)) throw new Error('Webhook URL must start with https://');
    out.webhook_url = w;
  }
  if (body.memory !== undefined) out.memory = str(body.memory, 4000);
  if (body.schedule !== undefined) {
    const s = body.schedule || {};
    const type = ['manual', 'interval', 'daily'].includes(s.type) ? s.type : 'manual';
    let value = '';
    if (type === 'interval') value = String(Math.max(config.minScheduleMinutes / 60, Number(s.hours) || 24));
    if (type === 'daily') value = JSON.stringify(parseSchedule('daily', { time: s.time, days: s.days }));
    out.schedule_type = type;
    out.schedule_value = value;
    out.schedule_task = str(s.task, 2000);
    out.next_run_at = nextRunAt(type, value, tz);
  }
  return out;
}

// ---------- public ----------
api.get('/config', (_req, res) => res.json({
  appName: config.appName,
  inviteRequired: !!config.inviteCode,
  demoAi: config.llmProvider !== 'anthropic',
  demoComputer: config.sandboxProvider !== 'e2b',
  freeMonthlyCreditUsd: config.freeMonthlyCreditUsd,
  maxAgentsPerUser: config.maxAgentsPerUser,
  minScheduleHours: config.minScheduleMinutes / 60,
  models: config.allowedModels.map(id => ({ id, label: MODEL_PRICES[id]?.label || id })),
  defaultModel: config.defaultModel,
}));

api.post('/signup', rateLimit(10, 15 * 60_000), (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const name = str(req.body.name, 60);
  const password = String(req.body.password || '');
  const tz = validTimezone(req.body.timezone) ? req.body.timezone : 'UTC';
  if (config.inviteCode && req.body.invite !== config.inviteCode) return bad(res, 'That invite code is not valid.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, 'Enter a valid email.');
  if (!name) return bad(res, 'Enter your name.');
  if (password.length < 8) return bad(res, 'Password must be at least 8 characters.');
  if (one('SELECT 1 FROM users WHERE email = ?', email)) return bad(res, 'An account with this email already exists.');
  const user = createUser({ email, name, password, timezone: tz });
  startSession(res, user.id);
  res.json({ user: publicUser(user) });
});

api.post('/login', rateLimit(20, 15 * 60_000), (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const user = one('SELECT * FROM users WHERE email = ?', email);
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) return bad(res, 'Wrong email or password.', 401);
  if (user.disabled) return bad(res, 'This account is disabled.', 403);
  startSession(res, user.id);
  res.json({ user: publicUser(user) });
});

api.post('/logout', (req, res) => { endSession(req, res); res.json({ ok: true }); });

// ---------- account ----------
api.get('/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null }));

api.patch('/me', requireUser, (req, res) => {
  const name = req.body.name !== undefined ? str(req.body.name, 60) : req.user.name;
  const tz = req.body.timezone !== undefined && validTimezone(req.body.timezone) ? req.body.timezone : req.user.timezone;
  run('UPDATE users SET name = ?, timezone = ? WHERE id = ?', name || req.user.name, tz, req.user.id);
  if (tz !== req.user.timezone) {
    for (const a of all(`SELECT * FROM agents WHERE user_id = ? AND schedule_type = 'daily'`, req.user.id)) {
      run('UPDATE agents SET next_run_at = ? WHERE id = ?', nextRunAt(a.schedule_type, a.schedule_value, tz), a.id);
    }
  }
  res.json({ user: publicUser(one('SELECT * FROM users WHERE id = ?', req.user.id)) });
});

// ---------- agents ----------
api.get('/agents', requireUser, (req, res) => {
  res.json({ agents: all('SELECT * FROM agents WHERE user_id = ? ORDER BY created_at DESC', req.user.id).map(publicAgent) });
});

api.post('/agents/draft', requireUser, rateLimit(30, 60 * 60_000), async (req, res) => {
  const prompt = str(req.body.prompt, 2000);
  if (prompt.length < 5) return bad(res, 'Describe what you want the agent to do.');
  if (!checkCredit(req, res)) return;
  try {
    const d = await draftAgent(prompt, req.user.timezone);
    const cost = priceOf(config.defaultModel, d.usage || {});
    if (cost > 0) run('INSERT INTO charges (user_id, reason, cost_usd, created_at) VALUES (?,?,?,?)', req.user.id, 'draft agent', cost, now());
    res.json({ draft: {
      name: d.name, emoji: d.emoji, role: d.role,
      schedule: { type: d.schedule_type, hours: d.schedule_hours, time: d.schedule_time, days: d.schedule_days, task: d.schedule_task },
    } });
  } catch (e) { bad(res, `Couldn't draft the agent: ${e.message}`, 500); }
});

api.post('/agents', requireUser, (req, res) => {
  const count = one('SELECT COUNT(*) AS n FROM agents WHERE user_id = ?', req.user.id).n;
  if (count >= config.maxAgentsPerUser && !req.user.is_admin) return bad(res, `You can have up to ${config.maxAgentsPerUser} agents.`);
  let f;
  try { f = agentFields({ schedule: { type: 'manual' }, ...req.body }, null, req.user.timezone); } catch (e) { return bad(res, e.message); }
  const id = newId('a_');
  run(`INSERT INTO agents (id, user_id, name, role, emoji, color, model, schedule_type, schedule_value, schedule_task, next_run_at, webhook_url, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, req.user.id, f.name, f.role, f.emoji || '🤖', f.color || '#6d5efc', f.model, f.schedule_type, f.schedule_value, f.schedule_task, f.next_run_at, f.webhook_url || '', now(), now());
  res.json({ agent: publicAgent(one('SELECT * FROM agents WHERE id = ?', id)) });
});

api.get('/agents/:id', requireUser, (req, res) => {
  const a = ownAgent(req, res); if (!a) return;
  res.json({ agent: publicAgent(a) });
});

api.patch('/agents/:id', requireUser, (req, res) => {
  const a = ownAgent(req, res); if (!a) return;
  let f;
  try { f = agentFields(req.body, a, req.user.timezone); } catch (e) { return bad(res, e.message); }
  const keys = Object.keys(f);
  if (keys.length) run(`UPDATE agents SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map(k => f[k]), now(), a.id);
  res.json({ agent: publicAgent(one('SELECT * FROM agents WHERE id = ?', a.id)) });
});

api.delete('/agents/:id', requireUser, async (req, res) => {
  const a = ownAgent(req, res); if (!a) return;
  for (const r of all(`SELECT id FROM runs WHERE agent_id = ? AND status IN ('queued','running')`, a.id)) stopRun(r.id);
  await destroyComputer(a);
  run('DELETE FROM agents WHERE id = ?', a.id);
  res.json({ ok: true });
});

api.post('/agents/:id/messages', requireUser, (req, res) => {
  const a = ownAgent(req, res); if (!a) return;
  const text = str(req.body.text, 8000);
  if (!text) return bad(res, 'Type a message.');
  if (!checkCredit(req, res)) return;
  const queued = one(`SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND status = 'queued'`, a.id).n;
  if (queued >= 3) return bad(res, 'This agent already has 3 tasks waiting. Let it catch up first.');
  res.json({ runId: enqueueRun(a, req.user, text, 'chat') });
});

api.post('/agents/:id/run', requireUser, (req, res) => {
  const a = ownAgent(req, res); if (!a) return;
  if (!checkCredit(req, res)) return;
  if (a.status !== 'idle') return bad(res, 'This agent is already working.');
  res.json({ runId: enqueueRun(a, req.user, a.schedule_task || 'Do your regular work now.', 'manual') });
});

api.post('/agents/:id/stop', requireUser, (req, res) => {
  const a = ownAgent(req, res); if (!a) return;
  for (const r of all(`SELECT id FROM runs WHERE agent_id = ? AND status IN ('queued','running')`, a.id)) stopRun(r.id);
  res.json({ ok: true });
});

api.post('/agents/:id/clear', requireUser, (req, res) => {
  const a = ownAgent(req, res); if (!a) return;
  if (a.status !== 'idle') return bad(res, 'Wait until the agent finishes.');
  run('DELETE FROM messages WHERE agent_id = ?', a.id);
  run('DELETE FROM events WHERE agent_id = ?', a.id);
  res.json({ ok: true });
});

api.get('/agents/:id/events', requireUser, (req, res) => {
  const a = ownAgent(req, res); if (!a) return;
  const after = Number(req.query.after) || 0;
  const rows = after
    ? all('SELECT * FROM events WHERE agent_id = ? AND id > ? ORDER BY id LIMIT 500', a.id, after)
    : all('SELECT * FROM (SELECT * FROM events WHERE agent_id = ? ORDER BY id DESC LIMIT 300) ORDER BY id', a.id);
  res.json({
    status: a.status,
    events: rows.map(e => ({ id: e.id, runId: e.run_id, type: e.type, data: JSON.parse(e.data_json), at: e.created_at })),
  });
});

api.get('/agents/:id/runs', requireUser, (req, res) => {
  const a = ownAgent(req, res); if (!a) return;
  res.json({ runs: all(`SELECT id, trigger, input, status, error, cost_usd, input_tokens, output_tokens, web_searches, sandbox_seconds, created_at, finished_at
                        FROM runs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50`, a.id) });
});

// Files on the agent's computer. Waking a sleeping cloud computer takes a few seconds.
async function withComputer(a, fn) {
  const c = computerFor(a);
  try { return await fn(c); } finally {
    const busy = one('SELECT status FROM agents WHERE id = ?', a.id)?.status === 'running';
    await c.release({ pause: !busy });
  }
}

const cleanPath = p => {
  const s = String(p || '.').replace(/\\/g, '/');
  if (s.split('/').includes('..')) throw new Error('Invalid path');
  return s.replace(/^\/+/, '') || '.';
};

api.get('/agents/:id/files', requireUser, async (req, res) => {
  const a = ownAgent(req, res); if (!a) return;
  if (!a.sandbox_id && config.sandboxProvider === 'e2b') return res.json({ path: '.', items: [] });
  try {
    const p = cleanPath(req.query.path);
    const items = await withComputer(a, c => c.list(p));
    items.sort((x, y) => (x.type === y.type ? x.name.localeCompare(y.name) : x.type === 'dir' ? -1 : 1));
    res.json({ path: p, items: items.filter(i => !i.name.startsWith('.')) });
  } catch (e) { bad(res, `Couldn't open the files: ${e.message}`, 500); }
});

api.get('/agents/:id/files/download', requireUser, async (req, res) => {
  const a = ownAgent(req, res); if (!a) return;
  try {
    const p = cleanPath(req.query.path);
    const buf = await withComputer(a, c => c.readBytes(p));
    if (req.query.preview && buf.length < 400_000) return res.json({ name: path.basename(p), text: buf.toString('utf8') });
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(p))}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(buf);
  } catch (e) { bad(res, `Couldn't read that file: ${e.message}`, 500); }
});

// ---------- admin ----------
api.get('/admin/users', requireUser, requireAdmin, (_req, res) => {
  const since = monthStart();
  const users = all('SELECT * FROM users ORDER BY created_at DESC').map(u => ({
    id: u.id, name: u.name, email: u.email, isAdmin: !!u.is_admin, disabled: !!u.disabled, createdAt: u.created_at,
    limitUsd: userLimit(u), customLimit: u.credit_limit_usd, spentUsd: userSpendThisMonth(u.id),
    agents: one('SELECT COUNT(*) AS n FROM agents WHERE user_id = ?', u.id).n,
    runs: one('SELECT COUNT(*) AS n FROM runs WHERE user_id = ? AND created_at >= ?', u.id, since).n,
  }));
  const totals = {
    users: users.length,
    agents: one('SELECT COUNT(*) AS n FROM agents').n,
    runsThisMonth: one('SELECT COUNT(*) AS n FROM runs WHERE created_at >= ?', since).n,
    spendThisMonth: one('SELECT COALESCE(SUM(cost_usd),0) AS c FROM runs WHERE created_at >= ?', since).c
      + one('SELECT COALESCE(SUM(cost_usd),0) AS c FROM charges WHERE created_at >= ?', since).c,
    running: one(`SELECT COUNT(*) AS n FROM runs WHERE status = 'running'`).n,
  };
  res.json({ users, totals });
});

api.patch('/admin/users/:id', requireUser, requireAdmin, (req, res) => {
  const u = one('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!u) return bad(res, 'User not found.', 404);
  if (req.body.limitUsd !== undefined) {
    const v = req.body.limitUsd === null || req.body.limitUsd === '' ? null : Math.max(0, Number(req.body.limitUsd));
    run('UPDATE users SET credit_limit_usd = ? WHERE id = ?', Number.isFinite(v) ? v : null, u.id);
  }
  if (req.body.disabled !== undefined && u.id !== req.user.id) {
    run('UPDATE users SET disabled = ? WHERE id = ?', req.body.disabled ? 1 : 0, u.id);
    if (req.body.disabled) run('DELETE FROM sessions WHERE user_id = ?', u.id);
  }
  if (req.body.isAdmin !== undefined && u.id !== req.user.id) run('UPDATE users SET is_admin = ? WHERE id = ?', req.body.isAdmin ? 1 : 0, u.id);
  res.json({ ok: true });
});

export { db };
