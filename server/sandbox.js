// Each agent gets its own cloud computer.
//  - "e2b":   a real Linux VM on E2B (browser-capable, terminal, file system). Paused between runs
//             so files and installed tools persist, and you only pay while it is awake.
//  - "local": DEVELOPMENT ONLY. Runs commands in a folder on this server. Never use in production.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Sandbox, CommandExitError } from 'e2b';
import { config } from './config.js';
import { run as dbRun } from './db.js';

export const WORKDIR_E2B = '/home/user/workspace';
const MAX_OUTPUT = 20_000;

const clip = (s = '') => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT / 2) + `\n…[${s.length - MAX_OUTPUT} chars cut]…\n` + s.slice(-MAX_OUTPUT / 2) : s);

// ---------- E2B ----------
class E2BComputer {
  constructor(agent) { this.agent = agent; this.sbx = null; this.awakeSince = 0; this.seconds = 0; }

  async wake() {
    if (this.sbx) return;
    const opts = { apiKey: config.e2bKey, timeoutMs: config.sandboxTimeoutMs };
    if (this.agent.sandbox_id) {
      try { this.sbx = await Sandbox.connect(this.agent.sandbox_id, opts); } // resumes a paused computer
      catch { this.sbx = null; } // expired or deleted: make a fresh one below
    }
    if (!this.sbx) {
      this.sbx = await Sandbox.create(config.sandboxTemplate, {
        ...opts,
        metadata: { agentId: this.agent.id, userId: this.agent.user_id },
        lifecycle: { onTimeout: 'pause' },
      });
      dbRun('UPDATE agents SET sandbox_id = ? WHERE id = ?', this.sbx.sandboxId, this.agent.id);
      this.agent.sandbox_id = this.sbx.sandboxId;
      await this.sbx.commands.run(`mkdir -p ${WORKDIR_E2B}`);
    }
    this.awakeSince = Date.now();
  }

  async exec(cmd, timeoutSec = 120) {
    await this.wake();
    try {
      const r = await this.sbx.commands.run(cmd, { cwd: WORKDIR_E2B, timeoutMs: Math.min(timeoutSec, 600) * 1000 });
      return { exitCode: r.exitCode, stdout: clip(r.stdout), stderr: clip(r.stderr) };
    } catch (e) {
      if (e instanceof CommandExitError) return { exitCode: e.exitCode, stdout: clip(e.stdout), stderr: clip(e.stderr) };
      return { exitCode: -1, stdout: '', stderr: String(e.message || e) };
    }
  }

  abs(p) { return p.startsWith('/') ? p : `${WORKDIR_E2B}/${p}`; }
  async write(p, content) { await this.wake(); await this.sbx.files.write(this.abs(p), content); }
  async read(p) { await this.wake(); return await this.sbx.files.read(this.abs(p)); }
  async readBytes(p) { await this.wake(); return Buffer.from(await this.sbx.files.read(this.abs(p), { format: 'bytes' })); }
  async list(p = '.') {
    await this.wake();
    const items = await this.sbx.files.list(this.abs(p));
    return items.map(i => ({ name: i.name, type: i.type === 'dir' ? 'dir' : 'file', size: i.size ?? 0 }));
  }

  // Put the computer to sleep (keeps files) and record how long it was awake.
  // pause=false is used when browsing files while a run is using the same computer.
  async release({ pause = true } = {}) {
    if (!this.sbx) return;
    this.seconds += (Date.now() - this.awakeSince) / 1000;
    if (pause) { try { await this.sbx.pause(); } catch { /* it will auto-pause on timeout */ } }
    this.sbx = null;
  }

  static async destroy(sandboxId) {
    if (!sandboxId) return;
    try { await Sandbox.kill(sandboxId, { apiKey: config.e2bKey }); } catch { /* already gone */ }
  }
}

// ---------- Local (dev only) ----------
class LocalComputer {
  constructor(agent) {
    this.agent = agent; this.seconds = 0; this.awakeSince = Date.now();
    this.root = path.join(config.dataDir, 'sandboxes', agent.id);
    fs.mkdirSync(this.root, { recursive: true });
  }
  safe(p) {
    const full = path.resolve(this.root, p.replace(/^\/+/, ''));
    if (!full.startsWith(this.root)) throw new Error('Path is outside the workspace');
    return full;
  }
  exec(cmd, timeoutSec = 120) {
    return new Promise(resolve => {
      const child = spawn('bash', ['-lc', cmd], { cwd: this.root, env: { PATH: process.env.PATH, HOME: this.root } });
      let out = '', err = '';
      const t = setTimeout(() => child.kill('SIGKILL'), timeoutSec * 1000);
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('close', code => { clearTimeout(t); resolve({ exitCode: code ?? -1, stdout: clip(out), stderr: clip(err) }); });
    });
  }
  async write(p, content) { const f = this.safe(p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); }
  async read(p) { return fs.readFileSync(this.safe(p), 'utf8'); }
  async readBytes(p) { return fs.readFileSync(this.safe(p)); }
  async list(p = '.') {
    const dir = this.safe(p);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).map(d => ({
      name: d.name, type: d.isDirectory() ? 'dir' : 'file', size: d.isDirectory() ? 0 : fs.statSync(path.join(dir, d.name)).size,
    }));
  }
  async release() { this.seconds += (Date.now() - this.awakeSince) / 1000; }
  static async destroy(_id, agentId) { if (agentId) fs.rmSync(path.join(config.dataDir, 'sandboxes', agentId), { recursive: true, force: true }); }
}

export function computerFor(agent) {
  return config.sandboxProvider === 'e2b' ? new E2BComputer(agent) : new LocalComputer(agent);
}

export async function destroyComputer(agent) {
  return config.sandboxProvider === 'e2b' ? E2BComputer.destroy(agent.sandbox_id) : LocalComputer.destroy(null, agent.id);
}
