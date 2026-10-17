// Each agent gets its own computer.
//  - "e2b":    a real Linux VM on E2B (paid). Paused between runs so files and installed tools persist.
//  - "docker": FREE. A Docker container per agent on your own server, with its files in its own volume.
//              Stopped between runs, started again when there is work.
//  - "local":  DEVELOPMENT ONLY. Runs commands in a folder on this server. Never use in production.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Sandbox, CommandExitError } from 'e2b';
import { config } from './config.js';
import { run as dbRun } from './db.js';

export const WORKDIR_E2B = '/home/user/workspace';
const MAX_OUTPUT = 20_000;
const WEBTOOL_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent-image', 'webtool.py');

const clip = (s = '') => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT / 2) + `\n…[${s.length - MAX_OUTPUT} chars cut]…\n` + s.slice(-MAX_OUTPUT / 2) : s);

// Arguments are passed as base64 JSON so nothing the AI writes can break out of the shell command.
const webtoolArgs = (kind, args) => `${kind} ${Buffer.from(JSON.stringify(args)).toString('base64')}`;

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
      await this.sbx.commands.run(`mkdir -p ${WORKDIR_E2B} /home/user/.crewbase`);
      await this.sbx.files.write('/home/user/.crewbase/webtool.py', fs.readFileSync(WEBTOOL_SRC, 'utf8'));
    }
    this.awakeSince = Date.now();
  }

  web(kind, args) { return this.exec(`python3 /home/user/.crewbase/webtool.py ${webtoolArgs(kind, args)}`, 60); }

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
  web(kind, args) { return this.exec(`python3 '${WEBTOOL_SRC}' ${webtoolArgs(kind, args)}`, 60); }
  async release() { this.seconds += (Date.now() - this.awakeSince) / 1000; }
  static async destroy(_id, agentId) { if (agentId) fs.rmSync(path.join(config.dataDir, 'sandboxes', agentId), { recursive: true, force: true }); }
}

// ---------- Docker (free, on your own server) ----------
// Runs the docker CLI. Resolves { code, stdout: Buffer, stderr: string }.
function docker(args, { input, timeoutMs = 60_000 } = {}) {
  return new Promise(resolve => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    let size = 0;
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', d => { size += d.length; if (size < 25_000_000) out.push(d); });
    child.stderr.on('data', d => err.push(d));
    child.on('error', e => { clearTimeout(t); resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(e.message) }); });
    child.on('close', code => { clearTimeout(t); resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }); });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

class DockerComputer {
  constructor(agent) {
    this.agent = agent; this.seconds = 0; this.awakeSince = 0; this.awake = false;
    this.name = `cb-${agent.id}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
  }

  async wake() {
    if (this.awake) return;
    const state = await docker(['inspect', '-f', '{{.State.Running}}', this.name]);
    if (state.code !== 0) {
      // First run: make this agent's computer, with a volume that keeps its files.
      const r = await docker(['run', '-d', '--init', '--name', this.name, '--hostname', 'agent',
        '--label', `crewbase.agent=${this.agent.id}`, '--label', `crewbase.user=${this.agent.user_id}`,
        '--network', config.dockerNetwork, '--dns', '1.1.1.1', '--dns', '8.8.8.8',
        '--cpus', config.dockerCpus, '--memory', config.dockerMemory, '--memory-swap', config.dockerMemory,
        '--pids-limit', '256', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '-v', `${this.name}-files:/workspace`,
        config.dockerImage], { timeoutMs: 120_000 });
      if (r.code !== 0) throw new Error(`Couldn't start the agent's computer: ${r.stderr.trim()}`);
      dbRun('UPDATE agents SET sandbox_id = ? WHERE id = ?', this.name, this.agent.id);
      this.agent.sandbox_id = this.name;
    } else if (state.stdout.toString().trim() !== 'true') {
      const r = await docker(['start', this.name]);
      if (r.code !== 0) throw new Error(`Couldn't wake the agent's computer: ${r.stderr.trim()}`);
    }
    this.awake = true;
    this.awakeSince = Date.now();
  }

  async exec(cmd, timeoutSec = 120) {
    await this.wake();
    const sec = Math.max(5, Math.min(Number(timeoutSec) || 120, 600));
    const r = await docker(['exec', '-w', '/workspace', this.name, 'timeout', '-k', '5', String(sec), 'bash', '-lc', cmd], { timeoutMs: (sec + 20) * 1000 });
    const exitCode = r.code === 124 ? 124 : r.code;
    return { exitCode, stdout: clip(r.stdout.toString('utf8')), stderr: clip(r.stderr + (r.code === 124 ? `\n(stopped after ${sec}s)` : '')) };
  }

  async write(p, content) {
    await this.wake();
    const r = await docker(['exec', '-i', '-w', '/workspace', this.name, 'sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', String(p)], { input: content });
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'Could not write the file');
  }

  async readBytes(p) {
    await this.wake();
    const r = await docker(['exec', '-w', '/workspace', this.name, 'cat', '--', String(p)]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'File not found');
    return r.stdout;
  }

  async read(p) { return (await this.readBytes(p)).toString('utf8'); }

  async list(p = '.') {
    await this.wake();
    const r = await docker(['exec', '-w', '/workspace', this.name, 'find', String(p), '-mindepth', '1', '-maxdepth', '1', '-printf', '%y\\t%s\\t%f\\n']);
    if (r.code !== 0) return [];
    return r.stdout.toString('utf8').split('\n').filter(Boolean).map(line => {
      const [t, s, ...n] = line.split('\t');
      return { name: n.join('\t'), type: t === 'd' ? 'dir' : 'file', size: Number(s) || 0 };
    });
  }

  web(kind, args) { return this.exec(`python3 /opt/crewbase/webtool.py ${webtoolArgs(kind, args)}`, 60); }

  async release({ pause = true } = {}) {
    if (!this.awake) return;
    this.seconds += (Date.now() - this.awakeSince) / 1000;
    if (pause) await docker(['stop', '-t', '3', this.name]);
    this.awake = false;
  }

  static async destroy(agent) {
    const name = `cb-${agent.id}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
    await docker(['rm', '-f', name]);
    await docker(['volume', 'rm', '-f', `${name}-files`]);
  }
}

export function computerFor(agent) {
  if (config.sandboxProvider === 'e2b') return new E2BComputer(agent);
  if (config.sandboxProvider === 'docker') return new DockerComputer(agent);
  return new LocalComputer(agent);
}

export async function destroyComputer(agent) {
  if (config.sandboxProvider === 'e2b') return E2BComputer.destroy(agent.sandbox_id);
  if (config.sandboxProvider === 'docker') return DockerComputer.destroy(agent);
  return LocalComputer.destroy(null, agent.id);
}
