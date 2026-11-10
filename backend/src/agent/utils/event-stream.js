const { providerError } = require('../providers/provider-errors');
const { assertNotCancelled } = require('./cancellation');

/** Write one JSON SSE frame, respecting the HTTP stream's backpressure. */
async function writeEvent(res, event, signal) {
  assertNotCancelled(signal);
  if (res.destroyed || res.writableEnded) throw providerError('AGENT_REQUEST_CANCELLED');
  // Event types are supplied only by server code. JSON escapes embedded newlines
  // so model text cannot inject an SSE event or control field.
  const frame = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
  if (res.write(frame)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      res.removeListener('drain', drained);
      res.removeListener('close', failed);
      res.removeListener('error', failed);
      signal?.removeEventListener('abort', failed);
    };
    const drained = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(providerError('AGENT_REQUEST_CANCELLED')); };
    const timer = setTimeout(failed, 10000);
    res.once('drain', drained);
    res.once('close', failed);
    res.once('error', failed);
    signal?.addEventListener('abort', failed, { once: true });
    if (signal?.aborted || res.destroyed) failed();
  });
}

module.exports = { writeEvent };
