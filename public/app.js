// Crewbase front end — a small single-page app, no build step.
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const state = { config: null, user: null, agents: [], timers: [] };

// ---------- helpers ----------
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : {};
  if (res.status === 401 && state.user) { state.user = null; go('/login'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => (n < 0.01 && n > 0 ? '<$0.01' : '$' + Number(n || 0).toFixed(2));
const go = p => { location.hash = '#' + p; };
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600); }
function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
function when(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
}
function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; }

// Tiny, safe markdown: escape first, then format.
function md(src) {
  const blocks = [];
  let s = esc(src).replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, c) => { blocks.push(`<pre><code>${c}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  const out = [];
  let list = null;
  for (const line of s.split('\n')) {
    const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (li) { const t = /^\s*\d/.test(line) ? 'ol' : 'ul'; if (!list) { list = t; out.push(`<${t}>`); } out.push(`<li>${li[1]}</li>`); continue; }
    if (list) { out.push(`</${list}>`); list = null; }
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) out.push(`<h3>${h[1]}</h3>`);
    else if (line.trim()) out.push(`<p>${line}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
}

const avatar = (a, size) => `<span class="av" style="background:${esc(a.color)}22;${size ? `width:${size}px;height:${size}px` : ''}" aria-hidden="true">${esc(a.emoji)}<span class="s ${esc(a.status)}"></span></span>`;
const statusText = a => a.status === 'running' ? 'Working now' : a.status === 'queued' ? 'Waiting to start' : a.schedule.label;

// ---------- routing ----------
const routes = [
  [/^\/$/, () => (state.user ? dashboard() : landing())],
  [/^\/login$/, () => authPage('login')],
  [/^\/signup$/, () => authPage('signup')],
  [/^\/new$/, () => needUser(createPage)],
  [/^\/a\/([\w-]+)(?:\/(files|runs|settings))?$/, (m) => needUser(() => agentPage(m[1], m[2] || 'chat'))],
  [/^\/account$/, () => needUser(accountPage)],
  [/^\/admin$/, () => needUser(adminPage)],
];
function needUser(fn) { if (!state.user) return go('/login'); return fn(); }
async function router() {
  clearTimers();
  const path = location.hash.replace(/^#/, '') || '/';
  for (const [re, fn] of routes) { const m = path.match(re); if (m) { await fn(m); window.scrollTo(0, 0); return; } }
  go('/');
}
window.addEventListener('hashchange', router);

// ---------- landing ----------
function landing() {
  const n = state.config.appName;
  document.title = `${n} — AI agents with their own computers`;
  app.innerHTML = `
  <header class="top"><a class="brand" href="#/"><i></i>${esc(n)}</a>
    <nav><a class="btn ghost small" href="#/login">Log in</a><a class="btn small" href="#/signup">Start free</a></nav></header>
  <main>
    <section class="hero">
      <div>
        <h1>Hire an agent that has its own computer.</h1>
        <p class="lede">Describe a job in one sentence. ${esc(n)} gives it an AI agent with a private cloud computer that searches the web, runs code, saves files and reports back, on a schedule or whenever you ask.</p>
        <div class="ctas"><a class="btn signal" href="#/signup">Create your first agent</a><a class="btn ghost" href="#/login">I have an account</a></div>
      </div>
      <div class="rig" aria-label="Example: an agent working on its computer">
        <div class="rig-bar"><span>🧭</span><span class="who">Job Scout</span><span>· computer #a7f2</span><span class="live"><span class="dot on"></span>working</span></div>
        <div class="rig-body" id="demo"></div>
      </div>
    </section>
    <section class="how">
      <div><b>1</b><h3>Say what you need</h3><p>"Every Sunday at 8, find new partnership jobs in Riyadh and send me the best ten." That's the whole setup.</p></div>
      <div><b>2</b><h3>It gets its own computer</h3><p>Each agent works on a separate cloud machine with a terminal, files and the web. Its files are still there tomorrow.</p></div>
      <div><b>3</b><h3>Results come to you</h3><p>Chat with it, download what it made, or get a ping in Slack or Discord when something is ready.</p></div>
    </section>
  </main>
  <footer class="foot">${esc(n)} · ${state.config.freeMode ? `free · up to ${state.config.maxRunsPerDay} agent tasks a day` : `${money(state.config.freeMonthlyCreditUsd)} of free agent work every month`}</footer>`;
  playDemo($('#demo'));
}

function playDemo(el) {
  const script = [
    ['d', '▸ Scheduled run · Sun 08:00'],
    ['t', 'Searching for new partnership roles in Riyadh…'],
    ['c', '⌕ web_search  "business development manager Riyadh"'],
    ['c', '⌕ web_search  "partnerships lead Saudi Arabia hiring"'],
    ['c', '$ python3 rank.py --since 7d --top 10'],
    ['o', '  14 new postings · 10 match your profile'],
    ['c', '$ write reports/jobs-2026-10-18.csv'],
    ['t', 'Done. 10 new roles saved. Best match: Partnerships Lead at a Riyadh mobility startup.'],
  ];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const render = (n, partial = '') => {
    el.innerHTML = script.slice(0, n).map(([k, t]) => `<div class="${k}">${esc(t)}</div>`).join('')
      + (n < script.length ? `<div class="${script[n][0]}">${esc(partial)}<span class="caret"></span></div>` : '<span class="caret"></span>');
  };
  if (reduce) return render(script.length);
  let line = 0, ch = 0;
  const tick = () => {
    if (!document.body.contains(el)) return;
    if (line >= script.length) { setTimeout(() => { line = 0; ch = 0; tick(); }, 4000); return; }
    const full = script[line][1];
    ch += 2;
    if (ch >= full.length) { line++; ch = 0; render(line); setTimeout(tick, 420); return; }
    render(line, full.slice(0, ch)); setTimeout(tick, 22);
  };
  tick();
}

// ---------- auth ----------
function authPage(kind) {
  if (state.user) return go('/');
  const n = state.config.appName;
  const signup = kind === 'signup';
  app.innerHTML = `
  <div class="auth">
    <a class="brand" href="#/"><i></i>${esc(n)}</a>
    <h1>${signup ? 'Create your account' : 'Welcome back'}</h1>
    <p class="sub">${signup ? (state.config.freeMode ? `Free. Your agents can do up to ${state.config.maxRunsPerDay} tasks a day.` : `You get ${money(state.config.freeMonthlyCreditUsd)} of agent work free every month.`) : 'Log in to see what your agents did.'}</p>
    <form id="f" novalidate>
      ${signup ? '<label for="name">Your name</label><input id="name" autocomplete="name" required>' : ''}
      <label for="email">Email</label><input id="email" type="email" autocomplete="email" required>
      <label for="pw">Password</label><input id="pw" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="8">
      ${signup ? '<p class="hint">At least 8 characters.</p>' : ''}
      ${signup && state.config.inviteRequired ? '<label for="inv">Invite code</label><input id="inv" required>' : ''}
      <p class="err" id="err"></p>
      <button class="btn signal" type="submit">${signup ? 'Create account' : 'Log in'}</button>
    </form>
    <p class="alt">${signup ? 'Already have an account? <a href="#/login">Log in</a>' : 'New here? <a href="#/signup">Create an account</a>'}</p>
  </div>`;
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true; $('#err').textContent = '';
    try {
      const body = { email: $('#email').value, password: $('#pw').value };
      if (signup) Object.assign(body, { name: $('#name').value, invite: $('#inv')?.value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      const r = await api(signup ? '/signup' : '/login', { body });
      state.user = r.user;
      await loadAgents();
      go(signup ? '/new' : '/');
    } catch (err) { $('#err').textContent = err.message; btn.disabled = false; }
  };
}

// ---------- shell ----------
async function loadAgents() {
  const [a, m] = await Promise.all([api('/agents'), api('/me')]);
  state.agents = a.agents; state.user = m.user;
}

function shell(activeId, inner) {
  const u = state.user, pct = Math.min(100, (u.usage.spentUsd / Math.max(u.usage.limitUsd, 0.0001)) * 100);
  app.innerHTML = `
  <div class="shell" id="shell">
    <div class="mobilebar"><a class="brand" href="#/"><i></i>${esc(state.config.appName)}</a><button class="btn ghost small" id="menu" aria-expanded="false">Menu</button></div>
    <aside class="rail" aria-label="Your agents">
      <a class="brand" href="#/"><i></i>${esc(state.config.appName)}</a>
      <a class="btn signal new" href="#/new">New agent</a>
      <div class="rail-h">Your agents</div>
      <div id="railList">${railList(activeId)}</div>
      <div class="spacer"></div>
      ${state.config.freeMode ? (() => {
        const tp = Math.min(100, (u.usage.runsToday / Math.max(u.usage.runsPerDay, 1)) * 100);
        return `<div class="meter" title="Counts tasks started in the last 24 hours">Tasks today: ${u.usage.runsToday} of ${u.usage.runsPerDay}
          <div class="bar"><i class="${tp > 80 ? 'hot' : ''}" style="width:${tp}%"></i></div></div>`;
      })() : `<div class="meter" title="Resets on the 1st of each month">This month: ${money(u.usage.spentUsd)} of ${money(u.usage.limitUsd)}
        <div class="bar"><i class="${pct > 80 ? 'hot' : ''}" style="width:${pct}%"></i></div></div>`}
      <div class="rail-foot">
        <a href="#/account">Account</a>
        ${u.isAdmin ? '<a href="#/admin">Admin</a>' : ''}
        <button id="logout">Log out</button>
      </div>
    </aside>
    <main class="main" id="main">${inner}</main>
  </div>`;
  $('#logout').onclick = async () => { await api('/logout', { method: 'POST' }); state.user = null; go('/'); };
  $('#menu').onclick = () => { const s = $('#shell'); s.classList.toggle('menu'); $('#menu').setAttribute('aria-expanded', s.classList.contains('menu')); };
  // keep statuses fresh
  state.timers.push(setInterval(async () => {
    try { await loadAgents(); const r = $('#railList'); if (r) r.innerHTML = railList(activeId); } catch { /* offline */ }
  }, 8000));
}

function railList(activeId) {
  if (!state.agents.length) return '<p class="hint" style="padding:4px 10px">No agents yet.</p>';
  return state.agents.map(a => `
    <a class="ag-link ${a.id === activeId ? 'active' : ''}" href="#/a/${a.id}">
      ${avatar(a)}<span style="min-width:0"><span class="nm" style="display:block">${esc(a.name)}</span><span class="st">${esc(statusText(a))}</span></span>
    </a>`).join('');
}

function demoBanner() {
  const c = state.config;
  if (!c.demoAi && !c.demoComputer) return '';
  return `<div class="banner"><b>Test mode.</b> ${c.demoAi ? 'Agents give scripted replies because no Anthropic API key is set. ' : ''}${c.demoComputer ? 'Computers are local folders on the server, not cloud machines, because no E2B key is set.' : ''}</div>`;
}

// ---------- dashboard ----------
async function dashboard() {
  await loadAgents();
  document.title = `Agents — ${state.config.appName}`;
  const desks = state.agents.map(a => `
    <a class="desk" href="#/a/${a.id}">
      <div class="desk-h">${avatar(a)}<div style="min-width:0"><h3>${esc(a.name)}</h3><div class="st">${esc(statusText(a))}</div></div></div>
      <div class="desk-screen">${a.lastMessage ? esc(a.lastMessage.replace(/[*`#_>]/g, '').slice(0, 220)) : '<span style="color:var(--screen-dim)">No work yet. Say hello to get it started.</span>'}</div>
      <div class="desk-f"><span>${a.lastRun ? `Last run ${ago(a.lastRun.created_at)}` : 'Never run'}</span><span>${state.config.freeMode ? `${a.monthRuns} task${a.monthRuns === 1 ? '' : 's'} this month` : `${money(a.monthCostUsd)} this month`}</span></div>
    </a>`).join('');
  shell(null, `
    ${demoBanner()}
    <div class="page-h"><div><h1>Your agents</h1><p>Each one works on its own cloud computer.</p></div>
      ${state.agents.length ? '<a class="btn" href="#/new">New agent</a>' : ''}</div>
    ${state.agents.length ? `<div class="desks">${desks}</div>` : `
      <div class="empty"><h2>Create your first agent</h2>
        <p>Tell it a job in plain words, like "check my competitors' prices every morning", and it will set itself up.</p>
        <a class="btn signal" href="#/new">Create an agent</a></div>`}`);
}

// ---------- create ----------
const STARTERS = [
  ['Job scout', 'Every Sunday and Wednesday at 8:00, find new business development and partnerships jobs in Riyadh posted in the last 4 days. Save them to a CSV and send me the 10 best matches with links.'],
  ['Competitor watch', 'Every morning, check the websites and news of my 3 main competitors (I will tell you who they are) and tell me anything new: prices, launches, campaigns, hires.'],
  ['Lead researcher', 'When I give you an industry and a city, research 20 companies that could buy outdoor and digital advertising, with website, size, and the right person to contact. Save as a CSV.'],
  ['Daily news brief', 'Every weekday at 7:30, read the top news about advertising, marketing and media in Saudi Arabia and the GCC, and give me a 5-point brief with links.'],
  ['Data analyst', 'When I give you a link to a CSV or spreadsheet, download it, clean it, analyse it with Python and give me the key findings plus charts saved as PNG files.'],
];
const EMOJIS = ['🤖', '🧭', '🔎', '📈', '🗞️', '🧑‍💼', '🛰️', '🧪', '📦', '🎯', '✍️', '💼'];
const COLORS = ['#6D5EFC', '#F25C05', '#1F8A5B', '#0E7CB6', '#C2341B', '#B26B00', '#7A3E9D', '#1B2333'];

function createPage() {
  document.title = `New agent — ${state.config.appName}`;
  shell(null, `
    <div class="create">
      <div class="page-h"><div><h1>New agent</h1><p>Describe the job. You can change everything after.</p></div></div>
      <label for="wish" class="sr">What should your agent do?</label>
      <textarea id="wish" class="wish" placeholder="What should your agent do? For example: every morning, find new partnership jobs in Riyadh and send me the best ten."></textarea>
      <div class="starters">${STARTERS.map((s, i) => `<button class="chip" data-i="${i}" type="button">${esc(s[0])}</button>`).join('')}</div>
      <div class="form-foot" style="margin-top:0"><button class="btn signal" id="draft">Set up my agent</button><button class="btn ghost" id="manual">Fill in myself</button></div>
      <p class="err" id="err"></p>
      <div id="form"></div>
    </div>`);
  $('.starters').onclick = e => { const b = e.target.closest('.chip'); if (b) { $('#wish').value = STARTERS[b.dataset.i][1]; $('#wish').focus(); } };
  $('#manual').onclick = () => agentForm($('#form'), { name: '', emoji: '🤖', color: COLORS[0], role: $('#wish').value, model: state.config.defaultModel, schedule: { type: 'manual' } }, 'create');
  $('#draft').onclick = async () => {
    const wish = $('#wish').value.trim();
    if (wish.length < 5) { $('#err').textContent = 'Write a sentence about what the agent should do.'; return; }
    const b = $('#draft'); b.disabled = true; b.textContent = 'Setting up…'; $('#err').textContent = '';
    try {
      const { draft } = await api('/agents/draft', { body: { prompt: wish } });
      agentForm($('#form'), { ...draft, color: COLORS[Math.floor(Math.random() * COLORS.length)], model: state.config.defaultModel }, 'create');
      $('#form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { $('#err').textContent = e.message; }
    b.disabled = false; b.textContent = 'Set up my agent';
  };
}

// Shared by "create" and the Settings tab.
function agentForm(el, a, mode) {
  const s = a.schedule || { type: 'manual' };
  const sv = s.value || s; // existing agents keep values in schedule.value
  const days = sv.days || [0, 1, 2, 3, 4, 5, 6];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  el.innerHTML = `
  <form class="card" id="af" novalidate style="margin-top:22px">
    <div class="row2">
      <div><label for="emoji">Icon</label><select id="emoji">${EMOJIS.concat(EMOJIS.includes(a.emoji) ? [] : [a.emoji]).map(e => `<option ${e === a.emoji ? 'selected' : ''}>${e}</option>`).join('')}</select></div>
      <div><label for="nm">Name</label><input id="nm" value="${esc(a.name)}" maxlength="40" required></div>
    </div>
    <label for="role">Instructions</label>
    <textarea id="role" rows="8">${esc(a.role)}</textarea>
    <p class="hint">Who the agent is, what it should do, and how it should report back.</p>

    <label>When should it work?</label>
    <div class="days" id="stype">
      ${[['manual', 'Only when I ask'], ['daily', 'On certain days'], ['interval', 'Every few hours']].map(([v, l]) => `<button type="button" class="chip ${s.type === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}
    </div>
    <div id="sdetail"></div>

    <div class="row3">
      <div><label for="model">AI model</label><select id="model">${state.config.models.map(m => `<option value="${m.id}" ${m.id === a.model ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></div>
      <div><label for="color">Color</label><select id="color">${COLORS.map(c => `<option value="${c}" ${c.toLowerCase() === String(a.color).toLowerCase() ? 'selected' : ''} style="color:${c}">■ ${c}</option>`).join('')}</select></div>
      <div><label for="hook">Slack or Discord webhook</label><input id="hook" placeholder="https://hooks.slack.com/…" value="${esc(a.webhookUrl || '')}"></div>
    </div>
    <p class="hint">Optional: paste an incoming-webhook link and the agent can ping you there.</p>
    ${mode === 'edit' ? `<label for="mem">Memory</label><textarea id="mem" rows="5" placeholder="The agent writes notes here that it reads at the start of every run.">${esc(a.memory || '')}</textarea>` : ''}
    <p class="err" id="ferr"></p>
    <div class="form-foot">
      <button class="btn signal" type="submit">${mode === 'create' ? 'Create agent' : 'Save changes'}</button>
      ${mode === 'edit' ? '<button class="btn danger" type="button" id="del">Delete agent</button>' : ''}
    </div>
  </form>`;

  let type = s.type;
  let picked = new Set(days.map(Number));
  const drawDetail = () => {
    const box = $('#sdetail', el);
    if (type === 'manual') { box.innerHTML = '<p class="hint">It works when you send a message or press Run now.</p>'; return; }
    const taskField = `<label for="task">What to do each time</label><textarea id="task" rows="2" placeholder="e.g. Find new jobs since your last run and send me the best ones.">${esc(s.task || '')}</textarea>`;
    if (type === 'interval') {
      box.innerHTML = `<label for="hours">Every how many hours?</label><input id="hours" type="number" min="${state.config.minScheduleHours}" step="1" value="${esc(sv.hours || 24)}" style="max-width:140px">${taskField}`;
      return;
    }
    box.innerHTML = `<label>Days</label><div class="days" id="dpick">${dayNames.map((d, i) => `<button type="button" class="chip ${picked.has(i) ? 'on' : ''}" data-d="${i}" aria-pressed="${picked.has(i)}">${d}</button>`).join('')}</div>
      <label for="time">Time (${esc(state.user.timezone)})</label><input id="time" type="time" value="${esc(sv.time || '09:00')}" style="max-width:160px">${taskField}`;
    $('#dpick', el).onclick = e => {
      const b = e.target.closest('[data-d]'); if (!b) return;
      const d = Number(b.dataset.d); picked.has(d) ? picked.delete(d) : picked.add(d);
      b.classList.toggle('on', picked.has(d)); b.setAttribute('aria-pressed', picked.has(d));
    };
  };
  drawDetail();
  $('#stype', el).onclick = e => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    // keep the typed task when switching
    s.task = $('#task', el)?.value ?? s.task;
    type = b.dataset.v; $('#stype', el).querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === b)); drawDetail();
  };

  $('#af', el).onsubmit = async e => {
    e.preventDefault();
    const body = {
      name: $('#nm', el).value, emoji: $('#emoji', el).value, color: $('#color', el).value, role: $('#role', el).value,
      model: $('#model', el).value, webhookUrl: $('#hook', el).value,
      schedule: { type, task: $('#task', el)?.value || '', hours: $('#hours', el)?.value, time: $('#time', el)?.value, days: [...picked].sort() },
    };
    if (type === 'daily' && !picked.size) { $('#ferr', el).textContent = 'Pick at least one day.'; return; }
    if (mode === 'edit') body.memory = $('#mem', el).value;
    const btn = e.submitter; btn.disabled = true; $('#ferr', el).textContent = '';
    try {
      const r = mode === 'create' ? await api('/agents', { body }) : await api(`/agents/${a.id}`, { method: 'PATCH', body });
      await loadAgents();
      if (mode === 'create') { toast('Agent created'); go(`/a/${r.agent.id}`); } else { toast('Changes saved'); router(); }
    } catch (err) { $('#ferr', el).textContent = err.message; btn.disabled = false; }
  };
  $('#del', el)?.addEventListener('click', async () => {
    if (!confirm(`Delete ${a.name}? Its computer and all its files will be deleted. This can't be undone.`)) return;
    try { await api(`/agents/${a.id}`, { method: 'DELETE' }); await loadAgents(); toast('Agent deleted'); go('/'); } catch (err) { toast(err.message); }
  });
}

// ---------- agent workspace ----------
async function agentPage(id, tab) {
  let agent;
  try { agent = (await api(`/agents/${id}`)).agent; } catch { return go('/'); }
  await loadAgents();
  document.title = `${agent.name} — ${state.config.appName}`;
  const tabs = [['chat', 'Work'], ['files', 'Files'], ['runs', 'History'], ['settings', 'Settings']];
  const next = agent.schedule.nextRunAt && agent.schedule.type !== 'manual' ? ` · next run ${when(agent.schedule.nextRunAt)}` : '';
  shell(id, `
    <div class="ws-h">
      <span class="av" style="background:${esc(agent.color)}22" aria-hidden="true">${esc(agent.emoji)}</span>
      <div><h1>${esc(agent.name)}</h1><div class="meta">${esc(agent.schedule.label)}${next}</div></div>
      <div class="acts">
        <button class="btn ghost small" id="runNow" ${agent.status !== 'idle' ? 'disabled' : ''}>Run now</button>
        <button class="btn ghost small" id="stop" ${agent.status === 'idle' ? 'hidden' : ''}>Stop</button>
      </div>
    </div>
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/a/${id}${k === 'chat' ? '' : '/' + k}" class="${k === tab ? 'on' : ''}" ${k === tab ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
    <div id="tab"></div>`);
  $('#runNow').onclick = async () => {
    try { await api(`/agents/${id}/run`, { method: 'POST' }); toast('Started'); if (tab !== 'chat') go(`/a/${id}`); else setBusy(true); } catch (e) { toast(e.message); }
  };
  $('#stop').onclick = async () => { await api(`/agents/${id}/stop`, { method: 'POST' }); toast('Stopping…'); };
  const box = $('#tab');
  if (tab === 'chat') return chatTab(box, agent);
  if (tab === 'files') return filesTab(box, agent);
  if (tab === 'runs') return runsTab(box, agent);
  agentForm(box, agent, 'edit');
  box.insertAdjacentHTML('beforeend', `<div class="form-foot"><button class="btn ghost small" id="clear">Clear chat history</button></div>`);
  $('#clear').onclick = async () => {
    if (!confirm('Clear the chat? The agent forgets the conversation but keeps its memory and files.')) return;
    try { await api(`/agents/${id}/clear`, { method: 'POST' }); toast('Chat cleared'); } catch (e) { toast(e.message); }
  };
}

function setBusy(busy) {
  const t = $('#typing'); if (t) t.hidden = !busy;
  const s = $('#stop'); if (s) s.hidden = !busy;
  const r = $('#runNow'); if (r) r.disabled = busy;
}

function chatTab(box, agent) {
  box.innerHTML = `
  <div class="work">
    <section class="chat" aria-label="Conversation">
      <div class="msgs" id="msgs"></div>
      <div class="typing" id="typing" hidden><span class="dot on"></span>${esc(agent.name)} is working…</div>
      <form class="composer" id="send">
        <label for="say" class="sr">Message ${esc(agent.name)}</label>
        <textarea id="say" rows="1" placeholder="Give ${esc(agent.name)} a task…"></textarea>
        <button class="btn signal" type="submit">Send</button>
      </form>
    </section>
    <section class="screen" aria-label="${esc(agent.name)}'s computer">
      <div class="rig-bar"><span>🖥️</span><span class="who">${esc(agent.name)}'s computer</span><span class="live" id="live"><span class="dot"></span>asleep</span></div>
      <div class="rig-body" id="scr"></div>
    </section>
  </div>`;

  let lastId = 0, sawAny = false;
  const msgs = $('#msgs'), scr = $('#scr');
  const atBottom = el => el.scrollHeight - el.scrollTop - el.clientHeight < 80;

  const add = events => {
    const stickM = atBottom(msgs), stickS = atBottom(scr);
    for (const e of events) {
      lastId = Math.max(lastId, e.id); sawAny = true;
      const d = e.data;
      if (e.type === 'user') {
        msgs.insertAdjacentHTML('beforeend', `<div class="msg me">${d.trigger !== 'chat' ? `<span class="tag">${d.trigger === 'schedule' ? 'Scheduled task' : 'Run now'}</span>` : ''}${esc(d.text)}</div>`);
        scr.insertAdjacentHTML('beforeend', `<div class="run-sep">▸ ${d.trigger === 'schedule' ? 'Scheduled run' : d.trigger === 'manual' ? 'Run now' : 'New task'} · ${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>`);
      } else if (e.type === 'text') {
        msgs.insertAdjacentHTML('beforeend', `<div class="msg bot"><div class="md">${md(d.text)}</div></div>`);
      } else if (e.type === 'notify') {
        msgs.insertAdjacentHTML('beforeend', `<div class="msg note"><b>Notification</b>${md(d.message)}</div>`);
      } else if (e.type === 'error') {
        msgs.insertAdjacentHTML('beforeend', `<div class="msg errm">${esc(d.message)}</div>`);
        scr.insertAdjacentHTML('beforeend', `<div class="line" style="color:#FF9C86">✕ ${esc(d.message)}</div>`);
      } else if (e.type === 'status' && d.message) {
        msgs.insertAdjacentHTML('beforeend', `<div class="msg sys">${esc(d.message)}</div>`);
      } else if (e.type === 'done') {
        msgs.insertAdjacentHTML('beforeend', `<div class="msg sys">Finished · ${state.config.freeMode ? '' : `${money(d.cost)} · `}${d.steps} step${d.steps === 1 ? '' : 's'}</div>`);
        scr.insertAdjacentHTML('beforeend', `<div class="line d">✓ done, computer going to sleep</div>`);
      } else if (e.type === 'tool') {
        const icon = d.name === 'run_command' ? '' : d.name.startsWith('web') ? '⌕ ' : '◆ ';
        scr.insertAdjacentHTML('beforeend', `<div class="line c">${icon}${esc(d.label)}</div>`);
      } else if (e.type === 'tool_result' && d.name === 'run_command') {
        scr.insertAdjacentHTML('beforeend', `<div class="res ${d.ok ? '' : 'bad'}">${esc(d.output.replace(/^exit code: 0\n(stdout:\n)?/, '').slice(0, 800))}</div>`);
      }
    }
    if (stickM) msgs.scrollTop = msgs.scrollHeight;
    if (stickS) scr.scrollTop = scr.scrollHeight;
  };

  const poll = async () => {
    try {
      const r = await api(`/agents/${agent.id}/events?after=${lastId}`);
      add(r.events);
      const busy = r.status !== 'idle';
      setBusy(busy);
      $('#live').innerHTML = busy ? '<span class="dot on"></span>working' : '<span class="dot" style="background:var(--screen-dim)"></span>asleep';
      if (!sawAny && !msgs.children.length) {
        msgs.innerHTML = `<div class="msg sys" style="margin:auto;text-align:center;max-width:40ch">Give ${esc(agent.name)} its first task below. It will work on its own computer, which you can watch on the right.</div>`;
        scr.innerHTML = '<div class="d">Computer is asleep. It wakes up when there is work to do.</div>';
      } else if (sawAny && msgs.querySelector('.msg.sys:only-child')) { /* replaced on first event */ }
    } catch { /* retry on next tick */ }
  };
  const firstLoad = async () => {
    const r = await api(`/agents/${agent.id}/events`);
    if (r.events.length) { msgs.innerHTML = ''; scr.innerHTML = ''; }
    add(r.events); await poll();
    msgs.scrollTop = msgs.scrollHeight; scr.scrollTop = scr.scrollHeight;
  };
  firstLoad();
  state.timers.push(setInterval(poll, 1500));

  const say = $('#say');
  say.addEventListener('input', () => { say.style.height = 'auto'; say.style.height = Math.min(say.scrollHeight, 180) + 'px'; });
  say.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#send').requestSubmit(); } });
  $('#send').onsubmit = async e => {
    e.preventDefault();
    const text = say.value.trim(); if (!text) return;
    if (!sawAny) { msgs.innerHTML = ''; scr.innerHTML = ''; }
    say.value = ''; say.style.height = '';
    try { await api(`/agents/${agent.id}/messages`, { body: { text } }); setBusy(true); poll(); }
    catch (err) { say.value = text; toast(err.message); }
  };
  say.focus();
}

async function filesTab(box, agent) {
  let cwd = '.';
  const load = async () => {
    box.innerHTML = `<div class="files"><div class="crumbs">${crumbs(cwd)}</div><div id="flist"><p class="hint" style="padding:16px 18px">Waking up the computer to read its files…</p></div></div><div id="pv"></div>`;
    bindCrumbs();
    try {
      const r = await api(`/agents/${agent.id}/files?path=${encodeURIComponent(cwd)}`);
      $('#flist').innerHTML = r.items.length ? r.items.map(i => `
        <div class="frow"><span aria-hidden="true">${i.type === 'dir' ? '📁' : '📄'}</span>
          <button class="fn" data-t="${i.type}" data-n="${esc(i.name)}">${esc(i.name)}</button>
          <span class="sz">${i.type === 'file' ? fmtSize(i.size) : ''}</span>
          ${i.type === 'file' ? `<a class="btn ghost small" href="/api/agents/${agent.id}/files/download?path=${encodeURIComponent(join(cwd, i.name))}">Download</a>` : ''}
        </div>`).join('')
        : `<p class="hint" style="padding:16px 18px">${cwd === '.' ? `No files yet. Ask ${esc(agent.name)} to make something, like a report or a CSV.` : 'This folder is empty.'}</p>`;
      $('#flist').onclick = async e => {
        const b = e.target.closest('.fn'); if (!b) return;
        if (b.dataset.t === 'dir') { cwd = join(cwd, b.dataset.n); return load(); }
        $('#pv').innerHTML = '<p class="hint" style="margin-top:14px">Opening…</p>';
        try {
          const f = await api(`/agents/${agent.id}/files/download?preview=1&path=${encodeURIComponent(join(cwd, b.dataset.n))}`);
          $('#pv').innerHTML = f.text !== undefined ? `<div class="preview">${esc(f.text)}</div>` : '';
        } catch (err) { $('#pv').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
      };
    } catch (err) { $('#flist').innerHTML = `<p class="err" style="padding:16px 18px">${esc(err.message)}</p>`; }
  };
  const join = (a, b) => (a === '.' ? b : `${a}/${b}`);
  const crumbs = p => ['<button data-p=".">workspace</button>', ...(p === '.' ? [] : p.split('/').map((seg, i, arr) => `/ <button data-p="${esc(arr.slice(0, i + 1).join('/'))}">${esc(seg)}</button>`))].join(' ');
  const bindCrumbs = () => { $('.crumbs').onclick = e => { const b = e.target.closest('[data-p]'); if (b) { cwd = b.dataset.p; load(); } }; };
  const fmtSize = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  load();
}

async function runsTab(box, agent) {
  const { runs } = await api(`/agents/${agent.id}/runs`);
  if (!runs.length) { box.innerHTML = `<div class="empty"><h2>No runs yet</h2><p>Every task ${esc(agent.name)} works on shows up here with what it cost.</p></div>`; return; }
  box.innerHTML = `<div class="scroll-x"><table class="t">
    <thead><tr><th>When</th><th>Task</th><th>Result</th><th class="num">Web searches</th><th class="num">Computer time</th><th class="num">Cost</th></tr></thead>
    <tbody>${runs.map(r => `<tr>
      <td>${when(r.created_at)}<div class="hint">${r.trigger === 'schedule' ? 'Scheduled' : r.trigger === 'manual' ? 'Run now' : 'Chat'}</div></td>
      <td style="max-width:360px">${esc(r.input.slice(0, 160))}${r.error ? `<div class="hint" style="color:var(--bad)">${esc(r.error)}</div>` : ''}</td>
      <td><span class="pill ${r.status}">${{ done: 'Done', error: 'Failed', running: 'Working', queued: 'Waiting', stopped: 'Stopped' }[r.status] || r.status}</span></td>
      <td class="num">${r.web_searches}</td><td class="num">${Math.round(r.sandbox_seconds)} s</td><td class="num">${money(r.cost_usd)}</td></tr>`).join('')}</tbody></table></div>`;
}

// ---------- account ----------
function accountPage() {
  const u = state.user;
  document.title = `Account — ${state.config.appName}`;
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = [u.timezone]; }
  shell(null, `
    <div class="page-h"><div><h1>Account</h1><p>${esc(u.email)}</p></div></div>
    <form class="card" id="acc" style="max-width:560px">
      <label for="an">Name</label><input id="an" value="${esc(u.name)}">
      <label for="tz">Time zone</label><select id="tz">${zones.map(z => `<option ${z === u.timezone ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select>
      <p class="hint">Schedules run in this time zone.</p>
      <div class="form-foot"><button class="btn" type="submit">Save changes</button></div>
    </form>
    <div class="stats" style="max-width:560px;margin-top:22px">
      <div class="stat"><b>${money(u.usage.spentUsd)}</b><span>used this month</span></div>
      <div class="stat"><b>${money(u.usage.limitUsd)}</b><span>monthly credit</span></div>
    </div>`);
  $('#acc').onsubmit = async e => {
    e.preventDefault();
    try { const r = await api('/me', { method: 'PATCH', body: { name: $('#an').value, timezone: $('#tz').value } }); state.user = r.user; toast('Changes saved'); router(); }
    catch (err) { toast(err.message); }
  };
}

// ---------- admin ----------
async function adminPage() {
  if (!state.user.isAdmin) return go('/');
  document.title = `Admin — ${state.config.appName}`;
  const { users, totals } = await api('/admin/users');
  shell(null, `
    <div class="page-h"><div><h1>Admin</h1><p>Everyone's usage this month. Costs are estimates from token, search and computer time.</p></div></div>
    <div class="stats">
      <div class="stat"><b>${totals.users}</b><span>users</span></div>
      <div class="stat"><b>${totals.agents}</b><span>agents</span></div>
      <div class="stat"><b>${totals.runsThisMonth}</b><span>runs this month</span></div>
      <div class="stat"><b>${money(totals.spendThisMonth)}</b><span>your cost this month</span></div>
      <div class="stat"><b>${totals.running}</b><span>running now</span></div>
    </div>
    <div class="scroll-x"><table class="t"><thead><tr><th>User</th><th class="num">Agents</th><th class="num">Runs</th><th class="num">Used</th><th>Monthly limit ($)</th><th></th></tr></thead>
    <tbody>${users.map(u => `<tr data-id="${u.id}">
      <td><b>${esc(u.name)}</b>${u.isAdmin ? ' <span class="pill">admin</span>' : ''}${u.disabled ? ' <span class="pill error">disabled</span>' : ''}<div class="hint">${esc(u.email)} · joined ${new Date(u.createdAt).toLocaleDateString()}</div></td>
      <td class="num">${u.agents}</td><td class="num">${u.runs}</td><td class="num">${money(u.spentUsd)}</td>
      <td><input class="lim" type="number" min="0" step="0.5" value="${u.customLimit ?? ''}" placeholder="default ${state.config.freeMonthlyCreditUsd}" style="max-width:130px"></td>
      <td>${u.id === state.user.id ? '' : `<button class="btn ghost small dis">${u.disabled ? 'Enable' : 'Disable'}</button>`}</td></tr>`).join('')}</tbody></table></div>`);
  $('tbody').addEventListener('change', async e => {
    if (!e.target.classList.contains('lim')) return;
    const id = e.target.closest('tr').dataset.id;
    try { await api(`/admin/users/${id}`, { method: 'PATCH', body: { limitUsd: e.target.value } }); toast('Limit saved'); } catch (err) { toast(err.message); }
  });
  $('tbody').addEventListener('click', async e => {
    if (!e.target.classList.contains('dis')) return;
    const tr = e.target.closest('tr'), u = users.find(x => x.id === tr.dataset.id);
    try { await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { disabled: !u.disabled } }); toast(u.disabled ? 'User enabled' : 'User disabled'); adminPage(); } catch (err) { toast(err.message); }
  });
}

// ---------- boot ----------
(async () => {
  try {
    state.config = await api('/config');
    document.title = state.config.appName;
    const me = await api('/me');
    state.user = me.user;
    if (state.user) await loadAgents();
  } catch { app.innerHTML = '<p style="padding:40px">Could not reach the server. Refresh to try again.</p>'; return; }
  router();
})();
