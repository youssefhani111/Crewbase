// Free AI option: any OpenAI-compatible chat API (Google Gemini free tier by default, or Groq, OpenRouter…).
// The rest of the app speaks Anthropic-style messages, so this file translates both ways.
import { config } from './config.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Anthropic-style history → OpenAI chat messages.
function toOpenAI(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const raw = m.content.find(b => b.type === 'oa_raw');
      if (raw) { out.push(raw.message); continue; } // echo the model's own message back untouched (keeps thought signatures)
      const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      const calls = m.content.filter(b => b.type === 'tool_use').map(b => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      }));
      if (!text && !calls.length) continue;
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // user turn: tool results become "tool" messages, text stays as a user message
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const c = typeof b.content === 'string' ? b.content : (b.content || []).map(x => x.text || '').join('\n');
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? 'ERROR: ' : '') + c });
      }
    }
    const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (text) out.push({ role: 'user', content: text });
  }
  return out;
}

const toOpenAITools = tools => tools.filter(t => t.input_schema).map(t => ({
  type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

export async function callOpenAICompat({ model, system, tools, messages }) {
  const fnTools = toOpenAITools(tools);
  const body = {
    model,
    messages: toOpenAI(system, messages),
    ...(fnTools.length ? { tools: fnTools, tool_choice: 'auto' } : {}),
    max_tokens: config.maxTokensPerReply,
  };
  const url = config.openaiBaseUrl.replace(/\/+$/, '') + '/chat/completions';

  let res, data;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.openaiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    if (res.status === 429 || res.status >= 500) {
      // Free tiers allow only a few requests per minute: wait and try again.
      const wait = Number(res.headers.get('retry-after')) * 1000 || 15_000 * (attempt + 1);
      if (attempt < 3) { await sleep(Math.min(wait, 60_000)); continue; }
    }
    break;
  }
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok || !data?.choices?.length) {
    const msg = data?.error?.message || data?.[0]?.error?.message || text.slice(0, 300);
    const err = new Error(res.status === 429 ? `The free AI limit was reached for now. Try again in a few minutes. (${msg})` : msg);
    err.status = res.status;
    throw err;
  }

  const choice = data.choices[0];
  const msg = choice.message || {};
  const content = [{ type: 'oa_raw', message: { ...msg, role: 'assistant' } }];
  const textOut = Array.isArray(msg.content) ? msg.content.map(p => p.text || '').join('') : msg.content;
  if (textOut && textOut.trim()) content.push({ type: 'text', text: textOut });
  for (const c of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(c.function?.arguments || '{}'); } catch { input = { _raw: c.function?.arguments }; }
    content.push({ type: 'tool_use', id: c.id, name: c.function?.name, input });
  }
  const hasCalls = (msg.tool_calls || []).length > 0;
  return {
    content,
    stop_reason: hasCalls ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
    usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 },
  };
}

// Plain one-shot completion (used to draft a new agent).
export async function completeOpenAICompat(prompt, maxTokens = 1500) {
  const r = await callOpenAICompat({
    model: config.defaultModel,
    system: 'You design AI agents. Reply with ONLY a JSON object, no markdown fences.',
    tools: [],
    messages: [{ role: 'user', content: prompt }],
  });
  return { text: r.content.filter(b => b.type === 'text').map(b => b.text).join(''), usage: r.usage, maxTokens };
}
