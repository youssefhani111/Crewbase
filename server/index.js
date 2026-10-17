import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { loadUser } from './auth.js';
import { api } from './routes.js';
import { startRunner } from './runner.js';

if (config.sandboxProvider === 'local' && process.env.NODE_ENV === 'production' && process.env.ALLOW_LOCAL_SANDBOX !== 'true') {
  console.error('\n✖ Refusing to start: "local" computers run user commands directly on THIS server.\n  Use SANDBOX_PROVIDER=docker (free) or add E2B_API_KEY.\n');
  process.exit(1);
}

const app = express();
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(loadUser);
app.use('/api', api);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(publicDir, { maxAge: '1h' }));
app.get('/{*splat}', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(config.port, () => {
  console.log(`\n${config.appName} running on http://localhost:${config.port}`);
  console.log(`  AI:        ${{ anthropic: 'Claude API', openai: `${config.openaiBaseUrl} (${config.defaultModel})`, mock: 'DEMO (no AI key)' }[config.llmProvider]}`);
  console.log(`  Computers: ${{ e2b: 'E2B cloud', docker: `Docker containers (${config.dockerImage})`, local: 'LOCAL folder (dev only)' }[config.sandboxProvider]}\n`);
  startRunner();
});
