// The agent brain: takes a task, works on its own computer with Claude, records everything, tracks cost.
import { config, MODEL_PRICES, WEB_SEARCH_COST } from './config.js';
import { one, all, run, newId, now, addEvent, userSpendThisMonth, userLimit } from './db.js';
import { callModel } from './llm.js';
import { computerFor } from './sandbox.js';
import { nextRunAt } from './schedule.js';

// ---------- Tools the agent can use ----------
const CLIENT_TOOLS = [
  {
    name: 'run_command',
    description: 'Run a bash command on your own Linux cloud computer. The working directory is your workspace, which persists between runs. You can install software (pip, npm, apt with sudo), run Python/Node scripts, use curl, git, etc. Output is truncated if very long.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to run.' },
        timeout_seconds: { type: 'integer', description: 'Max seconds to wait (default 120, max 600).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file in your workspace. Use this for reports, notes, CSVs, code, and anything your owner should be able to download from the Files tab.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path relative to your workspace, e.g. reports/today.md' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file from your workspace.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'list_files',
    description: 'List files in a folder of your workspace.',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Folder path, default "."' } } },
  },
  {
    name: 'update_memory',
    description: 'Replace your long-term memory notes. They are shown to you at the start of every run. Keep them short (max ~3000 characters): owner preferences, what you have done, what to do next time. Rewrite the whole note, keeping what still matters.',
    input_schema: { type: 'object', properties: { memory: { type: 'string' } }, required: ['memory'] },
  },
  {
    name: 'notify_owner',
    description: 'Send your owner a short notification (it appears highlighted in the app, and in Slack/Discord if they connected a webhook). Use it for results they asked to be told about, or when you are blocked and need them.',
    input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  },
];

const SERVER_TOOLS = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 8 },
  { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 8, max_content_tokens: 20000 },
];

function systemPrompt(agent, user) {
  const local = new Date().toLocaleString('en-GB', { timeZone: user.timezone, dateStyle: 'full', timeStyle: 'short' });
  return `You are ${agent.name}, an AI agent on ${config.appName}, working for ${user.name}.

# Your job (written by your owner)
${agent.role}

# Your computer
You have your own Linux cloud computer. Your workspace folder persists between runs, so files you save stay there and your owner can download them from the Files tab. You can run commands, write and run code, install tools, and search and read the web.

# Your memory
${agent.memory?.trim() || '(empty — use update_memory to save anything worth remembering)'}

# How to work
- Do the work yourself with your tools; don't just describe a plan. Check your results.
- When a result is long (a report, a list, a dataset), save it as a file and summarise it in your reply.
- End every run with a short, clear reply to your owner: what you did and what you found.
- Update your memory when you learn something you'll need next time.
- Never make purchases, create accounts, enter passwords or payment details, or contact people on your owner's behalf.
- Current date and time for your owner (${user.timezone}): ${local}.`;
}

// ---------- Cost ----------
export function priceOf(model, usage) {
  const p = MODEL_PRICES[model] || MODEL_PRICES[config.defaultModel] || { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 };
  const inTok = usage.input_tokens || 0, outTok = usage.output_tokens || 0;
  const cw = usage.cache_creation_input_tokens || 0, cr = usage.cache_read_input_tokens || 0;
  const rate = p.long && inTok + cw + cr > 100_000 ? p.long : p;
  return (inTok * rate.in + outTok * rate.out + cw * rate.cacheWrite + cr * rate.cacheRead) / 1e6;
}

// ---------- Queue ----------
const queue = [];
const active = new Set();
const stopRequested = new Set();

export function enqueueRun(agent, user, input, trigger) {
  const id = newId('r_');
  run(`INSERT INTO runs (id, agent_id, user_id, trigger, input, status, created_at) VALUES (?,?,?,?,?, 'queued', ?)`,
    id, agent.id, user.id, trigger, input, now());
  run(`UPDATE agents SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'idle'`, now(), agent.id);
  addEvent(agent.id, id, 'user', { text: input, trigger });
  queue.push(id);
  pump();
  return id;
}

export function stopRun(runId) {
  const r = one('SELECT * FROM runs WHERE id = ?', runId);
  if (!r) return;
  if (r.status === 'queued') {
    const i = queue.indexOf(runId); if (i >= 0) queue.splice(i, 1);
    finishRun(r, 'stopped', 'Stopped before it started.');
  } else stopRequested.add(runId);
}

function pump() {
  while (active.size < config.maxConcurrentRuns) {
    // Only one run per agent at a time.
    const idx = queue.findIndex(id => {
      const r = one('SELECT agent_id FROM runs WHERE id = ?', id);
      return r && ![...active].some(a => one('SELECT agent_id FROM runs WHERE id = ?', a)?.agent_id === r.agent_id);
    });
    if (idx < 0) return;
    const id = queue.splice(idx, 1)[0];
    active.add(id);
    executeRun(id).catch(e => console.error('run crashed', id, e)).finally(() => { active.delete(id); stopRequested.delete(id); pump(); });
  }
}

function finishRun(r, status, error) {
  run(`UPDATE runs SET status = ?, error = ?, finished_at = ? WHERE id = ?`, status, error || null, now(), r.id);
  const pending = one(`SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND status IN ('queued','running')`, r.agent_id).n;
  run(`UPDATE agents SET status = ?, updated_at = ? WHERE id = ?`, pending ? 'queued' : 'idle', now(), r.agent_id);
  if (error) addEvent(r.agent_id, r.id, status === 'stopped' ? 'status' : 'error', { message: error });
}

// Conversation history from recent successful runs, so the agent can follow up on earlier chats.
function loadHistory(agentId, currentRunId) {
  const runs = all(`SELECT id FROM runs WHERE agent_id = ? AND status = 'done' ORDER BY created_at DESC LIMIT 8`, agentId).map(r => r.id).reverse();
  let msgs = [];
  for (const rid of runs) {
    msgs.push(...all('SELECT role, content_json FROM messages WHERE run_id = ? ORDER BY id', rid)
      .map(m => ({ role: m.role, content: JSON.parse(m.content_json) })));
  }
  // Keep the history from getting expensive: drop the oldest runs while it is very long.
  while (msgs.length && JSON.stringify(msgs).length > 300_000) {
    const nextStart = msgs.findIndex((m, i) => i > 0 && m.role === 'user' && typeof m.content === 'string');
    msgs = nextStart > 0 ? msgs.slice(nextStart) : [];
  }
  return msgs;
}

function saveMessage(agentId, runId, role, content) {
  run('INSERT INTO messages (agent_id, run_id, role, content_json, created_at) VALUES (?,?,?,?,?)', agentId, runId, role, JSON.stringify(content), now());
}

async function postWebhook(url, text) {
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text.slice(0, 1900) }), signal: AbortSignal.timeout(10_000) });
  } catch { /* ignore webhook failures */ }
}

async function runTool(block, ctx) {
  const { computer, agent } = ctx;
  const inp = block.input || {};
  switch (block.name) {
    case 'run_command': {
      const r = await computer.exec(String(inp.command || ''), Number(inp.timeout_seconds) || 120);
      const text = `exit code: ${r.exitCode}\n${r.stdout ? `stdout:\n${r.stdout}\n` : ''}${r.stderr ? `stderr:\n${r.stderr}` : ''}`.trim();
      return { text, ok: r.exitCode === 0 };
    }
    case 'write_file':
      await computer.write(String(inp.path), String(inp.content ?? ''));
      return { text: `Saved ${inp.path} (${String(inp.content ?? '').length} characters).`, ok: true };
    case 'read_file': {
      const t = await computer.read(String(inp.path));
      return { text: t.length > 40_000 ? t.slice(0, 40_000) + '\n…[file truncated]' : t, ok: true };
    }
    case 'list_files': {
      const items = await computer.list(String(inp.path || '.'));
      return { text: items.map(i => `${i.type === 'dir' ? '📁' : '📄'} ${i.name}${i.type === 'file' ? ` (${i.size} B)` : ''}`).join('\n') || '(empty)', ok: true };
    }
    case 'update_memory': {
      const mem = String(inp.memory || '').slice(0, 4000);
      run('UPDATE agents SET memory = ?, updated_at = ? WHERE id = ?', mem, now(), agent.id);
      agent.memory = mem;
      return { text: 'Memory updated.', ok: true };
    }
    case 'notify_owner': {
      const msg = String(inp.message || '').slice(0, 3000);
      addEvent(agent.id, ctx.runId, 'notify', { message: msg });
      if (agent.webhook_url) await postWebhook(agent.webhook_url, `${agent.emoji} ${agent.name}: ${msg}`);
      return { text: 'Notification sent.', ok: true };
    }
    default:
      return { text: `Unknown tool ${block.name}`, ok: false };
  }
}

function toolLabel(block) {
  const i = block.input || {};
  switch (block.name) {
    case 'run_command': return `$ ${i.command}`;
    case 'write_file': return `Saved ${i.path}`;
    case 'read_file': return `Read ${i.path}`;
    case 'list_files': return `Listed ${i.path || 'workspace'}`;
    case 'update_memory': return 'Updated memory';
    case 'notify_owner': return 'Notified you';
    default: return block.name;
  }
}

async function executeRun(runId) {
  const r = one('SELECT * FROM runs WHERE id = ?', runId);
  const agent = r && one('SELECT * FROM agents WHERE id = ?', r.agent_id);
  const user = agent && one('SELECT * FROM users WHERE id = ?', agent.user_id);
  if (!r || !agent || !user) return;

  const limit = userLimit(user);
  if (userSpendThisMonth(user.id) >= limit) {
    return finishRun(r, 'error', `Monthly credit used up ($${limit.toFixed(2)}). It resets on the 1st, or ask the admin for more.`);
  }

  run(`UPDATE runs SET status = 'running', started_at = ? WHERE id = ?`, now(), r.id);
  run(`UPDATE agents SET status = 'running', updated_at = ? WHERE id = ?`, now(), agent.id);
  addEvent(agent.id, r.id, 'status', { status: 'running' });

  const computer = computerFor(agent);
  const totals = { input: 0, output: 0, searches: 0, cost: 0 };
  const messages = loadHistory(agent.id, r.id);
  const first = { role: 'user', content: r.trigger === 'schedule' ? `[Scheduled run] ${r.input}` : r.input };
  messages.push(first);
  saveMessage(agent.id, r.id, 'user', first.content);
  const tools = [...CLIENT_TOOLS, ...SERVER_TOOLS];
  const ctx = { computer, agent, runId: r.id };

  let status = 'done', error = null, steps = 0;
  try {
    while (true) {
      if (stopRequested.has(r.id)) { status = 'stopped'; error = 'Stopped by you.'; break; }
      if (steps >= config.maxStepsPerRun) {
        const note = [{ type: 'text', text: `I stopped after ${steps} steps (the limit per run). Ask me to continue if needed.` }];
        messages.push({ role: 'assistant', content: note }); saveMessage(agent.id, r.id, 'assistant', note);
        addEvent(agent.id, r.id, 'text', { text: note[0].text });
        break;
      }
      steps++;

      const resp = await callModel({ model: agent.model, system: systemPrompt(agent, user), tools, messages });
      const u = resp.usage || {};
      const searches = u.server_tool_use?.web_search_requests || 0;
      const stepCost = priceOf(agent.model, u) + searches * WEB_SEARCH_COST;
      totals.input += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      totals.output += u.output_tokens || 0;
      totals.searches += searches;
      totals.cost += stepCost;
      run('UPDATE runs SET input_tokens = ?, output_tokens = ?, web_searches = ?, cost_usd = ? WHERE id = ?',
        totals.input, totals.output, totals.searches, totals.cost, r.id);

      // Drop null fields the API doesn't want echoed back, and any half-written tool call
      // (e.g. when the reply hit max_tokens), so the saved history stays valid for the next run.
      let content = resp.content.map(b => Object.fromEntries(Object.entries(b).filter(([, v]) => v !== null)));
      if (resp.stop_reason !== 'tool_use' && content.some(b => b.type === 'tool_use')) {
        content = content.filter(b => b.type !== 'tool_use');
        if (!content.length) content = [{ type: 'text', text: 'My reply was cut off. Ask me to continue.' }];
      }
      messages.push({ role: 'assistant', content });
      saveMessage(agent.id, r.id, 'assistant', content);

      for (const b of content) {
        if (b.type === 'text' && b.text.trim()) addEvent(agent.id, r.id, 'text', { text: b.text });
        if (b.type === 'server_tool_use' && b.name === 'web_search') addEvent(agent.id, r.id, 'tool', { name: 'web_search', label: `Searched the web: ${b.input?.query || ''}` });
        if (b.type === 'server_tool_use' && b.name === 'web_fetch') addEvent(agent.id, r.id, 'tool', { name: 'web_fetch', label: `Read ${b.input?.url || 'a page'}` });
      }

      if (resp.stop_reason === 'pause_turn') continue; // long web search: send it back to continue
      if (resp.stop_reason !== 'tool_use') break;

      const results = [];
      for (const b of content.filter(b => b.type === 'tool_use')) {
        addEvent(agent.id, r.id, 'tool', { name: b.name, label: toolLabel(b), input: b.input });
        let out;
        try { out = await runTool(b, ctx); } catch (e) { out = { text: `Error: ${e.message || e}`, ok: false }; }
        addEvent(agent.id, r.id, 'tool_result', { name: b.name, ok: out.ok, output: out.text.slice(0, 4000) });
        results.push({ type: 'tool_result', tool_use_id: b.id, content: out.text || '(no output)', is_error: !out.ok });
      }
      messages.push({ role: 'user', content: results });
      saveMessage(agent.id, r.id, 'user', results);

      if (userSpendThisMonth(user.id) >= limit) { status = 'error'; error = 'Monthly credit used up during this run, so I stopped.'; break; }
    }
  } catch (e) {
    status = 'error';
    error = e?.status ? `AI service error (${e.status}): ${e.message}` : `Something went wrong: ${e.message || e}`;
    console.error('run error', r.id, e);
  } finally {
    try { await computer.release(); } catch { /* ignore */ }
    const sandboxCost = computer.seconds * config.sandboxCostPerSecond;
    totals.cost += sandboxCost;
    run('UPDATE runs SET sandbox_seconds = ?, cost_usd = ? WHERE id = ?', computer.seconds, totals.cost, r.id);
    if (status === 'done') addEvent(agent.id, r.id, 'done', { cost: totals.cost, steps, seconds: Math.round(computer.seconds) });
    finishRun(r, status, error);
  }
}

// ---------- Scheduler + startup recovery ----------
export function startRunner() {
  // Recover from a restart.
  for (const r of all(`SELECT * FROM runs WHERE status = 'running'`)) finishRun(r, 'error', 'The server restarted during this run.');
  for (const r of all(`SELECT id FROM runs WHERE status = 'queued' ORDER BY created_at`)) queue.push(r.id);
  pump();

  setInterval(() => {
    const due = all(`SELECT a.*, u.timezone AS tz FROM agents a JOIN users u ON u.id = a.user_id
                     WHERE a.schedule_type != 'manual' AND a.next_run_at IS NOT NULL AND a.next_run_at <= ? AND u.disabled = 0`, now());
    for (const a of due) {
      const user = one('SELECT * FROM users WHERE id = ?', a.user_id);
      run('UPDATE agents SET next_run_at = ? WHERE id = ?', nextRunAt(a.schedule_type, a.schedule_value, a.tz, now()), a.id);
      if (a.status !== 'idle') continue; // still busy: skip this slot
      if (userSpendThisMonth(user.id) >= userLimit(user)) continue;
      enqueueRun(a, user, a.schedule_task || 'Do your regular scheduled work.', 'schedule');
    }
  }, 30_000);
}
