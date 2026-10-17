// Talks to Claude. In "mock" mode (no API key) it returns scripted replies so you can test the app for free.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

const client = config.llmProvider === 'anthropic' ? new Anthropic({ apiKey: config.anthropicKey }) : null;

export async function callModel({ model, system, tools, messages }) {
  if (!client) return mockModel(messages);

  // Cache the long, repeated parts (tools + system, and the conversation so far) to cut costs.
  const msgs = messages.map((m, i) => {
    if (i !== messages.length - 1 || typeof m.content === 'string') return m;
    const content = m.content.map((b, j) => (j === m.content.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b));
    return { ...m, content };
  });

  return client.messages.create({
    model,
    max_tokens: config.maxTokensPerReply,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools,
    messages: msgs,
  });
}

// Turns a one-line wish ("watch my competitors' prices every morning") into a full agent setup.
export async function draftAgent(prompt, timezone) {
  const fallback = {
    name: 'New agent',
    emoji: '🤖',
    role: `${prompt.trim()}\n\nWork carefully, save useful results as files, and finish with a short summary.`,
    schedule_type: /every|daily|morning|weekly|each day|كل/i.test(prompt) ? 'daily' : 'manual',
    schedule_time: '09:00',
    schedule_days: [0, 1, 2, 3, 4, 5, 6],
    schedule_task: prompt.trim(),
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  if (!client) return fallback;

  const resp = await client.messages.create({
    model: config.defaultModel,
    max_tokens: 1500,
    system: 'You design AI agents. Reply with ONLY a JSON object, no markdown fences.',
    messages: [{
      role: 'user',
      content: `A user wants an AI agent that has its own cloud computer (terminal, files, web search and web reading). Their request:\n"""${prompt}"""\n\nReturn JSON with keys:\n- name: short friendly agent name (max 3 words)\n- emoji: one emoji\n- role: clear instructions for the agent in second person ("You are..."), 80-200 words, covering goal, steps, output format and files to save. Write it in the same language as the request.\n- schedule_type: "manual", "interval" or "daily"\n- schedule_hours: number (for interval)\n- schedule_time: "HH:MM" 24h (for daily), in the user's time zone ${timezone}\n- schedule_days: array of weekday numbers 0=Sunday..6=Saturday (for daily)\n- schedule_task: what the agent should do on each scheduled run (one or two sentences)`,
    }],
  });
  const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
  try {
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    return { ...fallback, ...j, usage: resp.usage };
  } catch {
    return { ...fallback, usage: resp.usage };
  }
}

// ---- Mock model: lets you click through the whole app without paying for AI ----
let mockN = 0;
function mockModel(messages) {
  const last = messages[messages.length - 1];
  const usage = { input_tokens: 1200, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const lastIsToolResult = Array.isArray(last.content) && last.content.some(b => b.type === 'tool_result');
  const userText = typeof last.content === 'string' ? last.content
    : (last.content.find(b => b.type === 'text')?.text || '');

  if (!lastIsToolResult) {
    mockN++;
    return {
      stop_reason: 'tool_use', usage,
      content: [
        { type: 'text', text: '(Demo mode) Let me check my computer and save a note about this task.' },
        { type: 'tool_use', id: `toolu_mock_${mockN}a`, name: 'run_command', input: { command: 'uname -a && date && ls -la' } },
        { type: 'tool_use', id: `toolu_mock_${mockN}b`, name: 'write_file', input: { path: 'notes/last-task.md', content: `# Last task\n\n${userText}\n\nHandled at ${new Date().toISOString()}\n` } },
      ],
    };
  }
  return {
    stop_reason: 'end_turn', usage,
    content: [{ type: 'text', text: `Done. I ran a command on my own computer and saved **notes/last-task.md** in my files.\n\nThis is **demo mode** — add an \`ANTHROPIC_API_KEY\` to get real answers.` }],
  };
}
