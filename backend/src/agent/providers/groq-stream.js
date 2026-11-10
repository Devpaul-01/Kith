const { GROQ_LIMITS, groqUsageSchema, groqStreamChunkSchema } = require('../validators/groq.validator');
const { READ_TURN_LIMITS } = require('../validators/read-turn.validator');
const { providerError } = require('./provider-errors');
const { assertNotCancelled } = require('../utils/cancellation');

const invalid = () => providerError('AGENT_INVALID_RESPONSE');

/** Bounded SSE decoding across arbitrary byte, UTF-8 and CR/LF boundaries. */
async function* dataEvents(response, signal) {
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'text/event-stream' || !response.body
      || Number(response.headers.get('content-length')) > GROQ_LIMITS.streamBytes) throw invalid();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let buffer = '';
  let data = [];
  let eventBytes = 0;
  let skipLf = false;
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      assertNotCancelled(signal);
      const { value: chunk, done } = await reader.read();
      assertNotCancelled(signal);
      if (done) break;
      bytes += chunk.byteLength;
      if (bytes > GROQ_LIMITS.streamBytes) throw invalid();
      try { buffer += decoder.decode(chunk, { stream: true }); } catch { throw invalid(); }
      while (buffer.length) {
        if (skipLf) {
          if (buffer[0] === '\n') buffer = buffer.slice(1);
          skipLf = false;
        }
        const end = buffer.search(/[\r\n]/);
        if (end === -1) break;
        const line = buffer.slice(0, end);
        skipLf = buffer[end] === '\r';
        buffer = buffer.slice(end + 1);
        eventBytes += Buffer.byteLength(line, 'utf8') + 1;
        if (eventBytes > GROQ_LIMITS.responseBytes) throw invalid();
        if (line === '') {
          if (data.length) yield data.join('\n');
          data = [];
          eventBytes = 0;
        } else if (line === 'data' || line.startsWith('data:')) {
          data.push(line === 'data' ? '' : line.slice(5).replace(/^ /, ''));
        }
      }
      if (eventBytes + Buffer.byteLength(buffer, 'utf8') > GROQ_LIMITS.responseBytes) throw invalid();
    }
    // A complete stream must end with a dispatched [DONE] event, never an EOF
    // fragment. The consumer also requires a terminal completion before it.
    try { decoder.decode(); } catch { throw invalid(); }
  } finally {
    signal?.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

async function readStreamReply(response, { signal, onText, onUsage }) {
  let text = '';
  let refusal = '';
  let finish = null;
  let usage = null;
  const calls = new Map();

  for await (const event of dataEvents(response, signal)) {
    assertNotCancelled(signal);
    if (event === '[DONE]') {
      if (!finish) throw invalid();
      return { choices: [{ index: 0, finish_reason: finish, message: {
        role: 'assistant', content: text || null, refusal: refusal || null,
        tool_calls: [...calls.values()],
      } }] };
    }
    let raw;
    try { raw = JSON.parse(event); } catch { throw invalid(); }
    // Groq reports usage in x_groq; compatibility deployments use usage.
    // Retain valid usage even when the accompanying completion is rejected.
    for (const value of [raw?.usage, raw?.x_groq?.usage]) {
      const parsedUsage = groqUsageSchema.safeParse(value);
      if (!parsedUsage.success) throw invalid();
      if (parsedUsage.data) {
        if (usage && JSON.stringify(usage) !== JSON.stringify(parsedUsage.data)) throw invalid();
        usage = parsedUsage.data;
        onUsage(usage);
      }
    }
    const parsed = groqStreamChunkSchema.safeParse(raw);
    if (!parsed.success) throw invalid();
    const choice = parsed.data.choices[0];
    if (!choice) {
      if (!finish || !usage) throw invalid();
      continue;
    }
    if (finish) throw invalid();
    const delta = choice.delta;
    text += delta.content || '';
    refusal += delta.refusal || '';
    if (text.length > READ_TURN_LIMITS.replyChars || refusal.length > READ_TURN_LIMITS.replyChars
        || (text && refusal)) throw invalid();
    const indices = new Set();
    for (const fragment of delta.tool_calls || []) {
      if (indices.has(fragment.index)) throw invalid();
      indices.add(fragment.index);
      let call = calls.get(fragment.index);
      if (!call) {
        if (fragment.index !== calls.size || !fragment.id || fragment.type !== 'function') throw invalid();
        call = { id: fragment.id, type: 'function', function: { name: '', arguments: '' } };
        calls.set(fragment.index, call);
      } else if (fragment.id && fragment.id !== call.id) {
        throw invalid();
      }
      call.function.name += fragment.function?.name || '';
      call.function.arguments += fragment.function?.arguments || '';
      if (call.function.name.length > 64 || call.function.arguments.length > READ_TURN_LIMITS.argumentChars) throw invalid();
    }
    // Tool arguments, names, reasoning, provider metadata and usage never go
    // through this callback. Text is provisional until the turn's done event.
    const content = delta.refusal || delta.content;
    if (content) await onText(content);
    finish = choice.finish_reason || null;
  }
  throw invalid();
}

module.exports = { readStreamReply };
