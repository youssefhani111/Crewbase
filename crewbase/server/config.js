// All settings come from environment variables (see .env.example).
import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader so the app runs without extra packages.
const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  appName: env.APP_NAME || 'Crewbase',
  port: num(env.PORT, 3000),
  dataDir: path.resolve(env.DATA_DIR || './data'),
  publicUrl: env.PUBLIC_URL || '',

  // AI: "anthropic" (Claude, paid), "openai" (any OpenAI-compatible API, e.g. Gemini free tier), or "mock" (demo)
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  openaiKey: env.OPENAI_COMPAT_API_KEY || env.GEMINI_API_KEY || '',
  openaiBaseUrl: env.OPENAI_COMPAT_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/',
  llmProvider: env.LLM_PROVIDER
    || (env.ANTHROPIC_API_KEY ? 'anthropic' : (env.OPENAI_COMPAT_API_KEY || env.GEMINI_API_KEY) ? 'openai' : 'mock'),
  maxStepsPerRun: num(env.MAX_STEPS_PER_RUN, 25),
  maxTokensPerReply: num(env.MAX_TOKENS_PER_REPLY, 8000),

  // Cloud computers
  e2bKey: env.E2B_API_KEY || '',
  // "e2b" (paid cloud VMs), "docker" (free: containers on your own server), or "local" (dev only)
  sandboxProvider: env.SANDBOX_PROVIDER || (env.E2B_API_KEY ? 'e2b' : 'local'),
  dockerImage: env.DOCKER_AGENT_IMAGE || 'crewbase-agent:latest',
  dockerNetwork: env.DOCKER_AGENT_NETWORK || 'crewbase-agents',
  dockerCpus: env.DOCKER_AGENT_CPUS || '0.5',
  dockerMemory: env.DOCKER_AGENT_MEMORY || '768m',
  sandboxTemplate: env.E2B_TEMPLATE || 'base',
  sandboxTimeoutMs: num(env.SANDBOX_TIMEOUT_MINUTES, 15) * 60_000,
  sandboxCostPerSecond: num(env.SANDBOX_COST_PER_SECOND, 0.000046), // E2B default 2 vCPU + 4 GiB ≈ $0.17/hour

  // Limits (protect your wallet)
  freeMonthlyCreditUsd: num(env.FREE_MONTHLY_CREDIT_USD, 1),
  maxAgentsPerUser: num(env.MAX_AGENTS_PER_USER, 5),
  maxConcurrentRuns: num(env.MAX_CONCURRENT_RUNS, 4),
  minScheduleMinutes: num(env.MIN_SCHEDULE_MINUTES, 60),
  inviteCode: env.INVITE_CODE || '',
  adminEmails: (env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean),

  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
};

// Price per million tokens (USD), from platform.claude.com/docs/en/about-claude/pricing (Oct 2026).
// `long` applies when a single prompt is over 100k tokens (Haiku 5.5 only).
export const MODEL_PRICES = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50, cacheWrite: 0.125, cacheRead: 0.01, long: { in: 0.50, out: 2.50, cacheWrite: 0.625, cacheRead: 0.05 }, label: 'Haiku 5.5 — fastest, cheapest' },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.10, label: 'Sonnet 5.5 — smarter' },
  'claude-opus-5-5': { in: 4, out: 20, cacheWrite: 5, cacheRead: 0.20, label: 'Opus 5.5 — most capable' },
};
export const WEB_SEARCH_COST = 0.01; // $10 per 1,000 searches

// Models depend on the AI provider.
const defaultModels = config.llmProvider === 'openai' ? 'gemini-3.8-flash' : 'claude-haiku-5-5,claude-sonnet-5-5';
config.allowedModels = (env.ALLOWED_MODELS || defaultModels).split(',').map(s => s.trim()).filter(Boolean);
config.defaultModel = env.DEFAULT_MODEL || config.allowedModels[0];

// Free mode: no per-dollar billing, limit runs per day instead (free AI tiers have daily caps).
config.freeMode = config.llmProvider !== 'anthropic' && config.sandboxProvider !== 'e2b';
config.maxRunsPerUserPerDay = num(env.MAX_RUNS_PER_USER_PER_DAY, config.freeMode ? 15 : 1000);
if (config.sandboxProvider === 'docker') config.sandboxCostPerSecond = num(env.SANDBOX_COST_PER_SECOND, 0);

fs.mkdirSync(config.dataDir, { recursive: true });
