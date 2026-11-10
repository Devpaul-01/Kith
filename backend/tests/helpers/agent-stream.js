const { ReadableStream } = require('stream/web');

const usage = { prompt_tokens: 50, completion_tokens: 8, total_tokens: 58 };
const chunk = (delta = {}, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const frame = (value, newline = '\n') => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}${newline}${newline}`;
const textChunks = (text = 'Hello.') => [
  chunk({ role: 'assistant', content: text }),
  { ...chunk({}, 'stop'), x_groq: { usage } },
  '[DONE]',
];
const toolChunks = (name = 'get_dashboard', args = '{}') => [
  chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: args.slice(0, 1) } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(1) } }] }),
  { ...chunk({}, 'tool_calls'), x_groq: { usage } },
  '[DONE]',
];

function sseResponse(events = textChunks(), { split = 0, newline = '\n', suffix = '', headers = {} } = {}) {
  const bytes = Buffer.from(events.map((event) => frame(event, newline)).join('') + suffix);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const end = split ? Math.min(bytes.length, offset + split) : bytes.length;
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  }), { headers: { 'Content-Type': 'text/event-stream', ...headers } });
}

function parseEvents(text) {
  return text.trim().split('\n\n').map((frame) => {
    const [type, data] = frame.split('\n');
    return { type: type.slice(7), data: JSON.parse(data.slice(6)) };
  });
}

module.exports = { usage, chunk, frame, textChunks, toolChunks, sseResponse, parseEvents };
