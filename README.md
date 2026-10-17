# Crewbase

A Skydive-style platform: people sign up, describe a job in one sentence, and get an AI agent with **its own cloud computer**. Each agent can search and read the web, run commands and code, save files that persist, remember things between runs, run on a schedule, and ping its owner in Slack or Discord.

You host it. Users get a free monthly credit that you set, and you can see and cap everyone's spending.

## What's inside

| Part | What it does |
|---|---|
| Sign up / log in | Email + password accounts, secure cookies. Optional invite code. |
| Create an agent | User types a wish ("every morning, check my competitors' prices"). Claude drafts the name, instructions and schedule; the user edits and saves. |
| Work tab | Chat with the agent on the left; watch its computer (commands, searches, files) live on the right. |
| Files tab | Browse, preview and download what the agent made on its computer. |
| History tab | Every run with web searches, computer time and cost. |
| Settings | Instructions, schedule (days + time in the user's time zone, or every N hours), AI model, Slack/Discord webhook, editable memory, delete. |
| Admin | All users, agents, runs and your total cost this month; set per-user limits; disable users. |

**Each agent's computer** is an [E2B](https://e2b.dev) Linux sandbox. It's created on the agent's first run, **paused between runs** (files and installed tools are kept, and you pay nothing while it sleeps), and resumed for the next run.

**The brain** is Claude through the Anthropic API, with these tools: run a command, write/read/list files, update memory, notify the owner, plus Anthropic's built-in web search and web fetch.

## Costs (you pay these)

| Item | Price | Typical per agent run |
|---|---|---|
| Claude Haiku 5.5 (default) | $0.10 in / $0.50 out per million tokens | ~$0.005–0.03 |
| Claude Sonnet 5.5 (optional) | $2 in / $10 out per million tokens | ~$0.10–0.50 |
| Web search | $10 per 1,000 searches | ~$0.01–0.05 |
| E2B computer | ≈ $0.17 per hour awake (2 vCPU, 4 GB) | ~$0.003–0.03 |

So a typical daily Haiku agent costs roughly **$0.50–2 per month**. E2B's free Hobby plan includes **$100 of credit** (sessions up to 1 hour, 20 at once); move to Pro when you have real users. Every run's cost is recorded and counted against the user's monthly credit (`FREE_MONTHLY_CREDIT_USD`, default $1). When it's used up, their agents stop until the 1st of next month or until you raise their limit on the Admin page.

## Free forever setup (Oracle Cloud + Gemini)

Costs $0: the website and every agent's computer run on one **Oracle Cloud Always Free** server, and the agents think with **Google Gemini's free API tier**. Good for you and a small group; free tiers have daily limits.

| Part | Free option | Limits to know |
|---|---|---|
| Server + agent computers | Oracle Always Free VM (Ampere A1, 2 CPU / 12 GB since June 2026) | Each agent gets a Docker container (0.5 CPU, 768 MB). About 3 agents work at the same time; the rest wait their turn. |
| AI | Gemini 3.8 Flash, free tier | Daily request caps (see AI Studio). Google may use free-tier prompts to improve its products, so tell your users. |
| Web search | DuckDuckGo, from the agent's computer | Can be rate-limited if used heavily. |
| HTTPS address | `your-ip.sslip.io` with an automatic certificate | Use your own domain later by setting `DOMAIN=` when running setup. |

**Steps**

1. **Gemini key:** go to https://aistudio.google.com/apikey and create a free API key.
2. **Oracle server:** sign up at https://www.oracle.com/cloud/free/ → Create a VM instance → Image **Ubuntu 24.04**, Shape **Ampere VM.Standard.A1.Flex** with **2 OCPU / 12 GB** → download the SSH key → Create.
3. **Open the web ports:** in the instance page click the **Subnet** → **Security List** → **Add Ingress Rules**: source `0.0.0.0/0`, TCP, destination ports `80,443`.
4. **Install:** on your Mac open Terminal and run (use your key file and the instance's public IP):
   ```bash
   chmod 400 ~/Downloads/ssh-key-*.key
   ssh -i ~/Downloads/ssh-key-*.key ubuntu@YOUR_PUBLIC_IP
   curl -fsSL https://raw.githubusercontent.com/youssefhani111/Crewbase/main/deploy/setup.sh | bash
   ```
   It asks for your Gemini key, your email (admin) and an optional invite code, then prints your site's address.
5. Open the address, sign up with your admin email and create an agent.

**Update later:** SSH in and run the same `curl … | bash` line again. **Logs:** `sudo journalctl -u crewbase -f`.

**Safety:** agent containers run as a normal user with no extra privileges, CPU/memory limits, and a firewall that blocks them from the server itself, private networks and Oracle's metadata service. Containers are not as strongly isolated as E2B's virtual machines, so keep sign-ups invite-only.

## Run it on your computer (free test mode)

Needs [Node.js 22.13+](https://nodejs.org).

```bash
npm install
npm start
```

Open http://localhost:3000 and create an account (the first account is the admin).

With no keys, the app runs in **test mode**: agents give scripted replies and their "computer" is a folder on your machine. That lets you click through everything for free. Add the keys to `.env` (copy `.env.example`) to make agents real.

> Never put test mode on the internet: without E2B, user commands would run on your server. The app refuses to start in production without `E2B_API_KEY`.

## Put it online (Railway, about 15 minutes)

1. **Get the two keys**
   - Anthropic: https://platform.claude.com → API keys. Add a few dollars of credit.
   - E2B: https://e2b.dev → sign up → API keys.
2. **Put the code on GitHub** (new private repo, upload this folder).
3. **Railway**: https://railway.com → New project → Deploy from GitHub repo → pick it. Railway finds the Dockerfile.
4. **Add a volume** (so the database survives restarts): service → Settings → Volumes → mount path `/data`.
5. **Variables** (service → Variables), at minimum:
   ```
   ANTHROPIC_API_KEY=...
   E2B_API_KEY=...
   ADMIN_EMAILS=your@email.com
   APP_NAME=Crewbase
   FREE_MONTHLY_CREDIT_USD=1
   INVITE_CODE=pick-something   # remove when you open to the public
   ```
6. **Domain**: service → Settings → Networking → Generate domain (or add your own).
7. Open the site, sign up with your admin email, create an agent and say hello.

Render, Fly.io, or any VPS with Docker work the same way: run the Dockerfile, mount a volume at `/data`, set the variables.

## Before you open it to the public

- **Keep `INVITE_CODE` on** until you've watched real costs for a week on the Admin page.
- **Set budget alerts** in the Anthropic Console and E2B dashboard. The app's limits use estimates; your provider bills are the truth.
- **Abuse:** agents have real computers with internet. E2B isolates them from your server, but users could still misuse them (scraping, spam). Keep limits low, require invites, and disable bad accounts from Admin. Add Terms of Service and a Privacy Policy.
- **Taking payments:** v1 has free credits only. To sell plans, add Stripe Checkout and raise `credit_limit_usd` for paying users (the column already exists).
- **Single server:** runs are processed in the web server (SQLite + in-process queue). That's fine for hundreds of users. For more, move to Postgres and a separate worker.

## Ideas for v2

- Log in to websites for the user (browser in the sandbox with a custom E2B template, plus a secure secrets vault)
- Connect Gmail / Google Drive / Slack via OAuth so agents work inside users' tools, like Skydive
- Agent templates gallery, team workspaces, Stripe billing, email notifications

## Project layout

```
server/
  index.js      web server
  config.js     settings + model prices
  db.js         SQLite tables
  auth.js       accounts and sessions
  routes.js     API
  runner.js     agent loop, tools, cost tracking, scheduler
  sandbox.js    the agent's computer (E2B, or a local folder in test mode)
  schedule.js   time-zone-aware schedules
  llm.js        Claude API + test-mode replies + "draft my agent"
  llm-openai.js free AI option (Gemini or any OpenAI-compatible API)
public/         the website (no build step)
agent-image/    the agent computer for free mode (Docker image + web search/read tool)
deploy/         one-command Oracle setup and firewall rules
```
