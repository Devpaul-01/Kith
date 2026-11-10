const { EventEmitter, getEventListeners } = require('events');
const { writeEvent } = require('../../../src/agent/utils/event-stream');

function response(writable = false) {
  const res = new EventEmitter();
  res.write = jest.fn(() => writable);
  return res;
}

describe('SSE response flow control', () => {
  afterEach(() => jest.useRealTimers());

  it('waits for drain and removes every temporary listener', async () => {
    const res = response();
    const controller = new AbortController();
    let complete = false;
    const pending = writeEvent(res, { type: 'text_delta', data: { delta: 'Hello\n\nevent: done' } }, controller.signal)
      .then(() => { complete = true; });
    await Promise.resolve();
    expect(complete).toBe(false);
    res.emit('drain');
    await pending;
    expect(res.eventNames()).toEqual([]);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    expect(res.write.mock.calls[0][0].split('\n')).toHaveLength(4);
  });

  it.each(['close', 'error', 'abort'])('cancels blocked writes on %s', async (event) => {
    const res = response();
    const controller = new AbortController();
    const pending = writeEvent(res, { type: 'text_delta', data: { delta: 'Hello' } }, controller.signal);
    if (event === 'abort') controller.abort();
    else res.emit(event);
    await expect(pending).rejects.toMatchObject({ code: 'AGENT_REQUEST_CANCELLED' });
    expect(res.eventNames()).toEqual([]);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  it('bounds a stalled client to ten seconds', async () => {
    jest.useFakeTimers();
    const res = response();
    const assertion = expect(writeEvent(res, { type: 'done', data: {} }))
      .rejects.toMatchObject({ code: 'AGENT_REQUEST_CANCELLED' });
    await jest.advanceTimersByTimeAsync(10000);
    await assertion;
    expect(res.eventNames()).toEqual([]);
  });

  it('never writes to a cancelled or closed connection', async () => {
    const res = response(true);
    const controller = new AbortController();
    controller.abort();
    await expect(writeEvent(res, { type: 'done', data: {} }, controller.signal)).rejects.toMatchObject({ code: 'AGENT_REQUEST_CANCELLED' });
    res.destroyed = true;
    await expect(writeEvent(res, { type: 'done', data: {} })).rejects.toMatchObject({ code: 'AGENT_REQUEST_CANCELLED' });
    expect(res.write).not.toHaveBeenCalled();
  });
});
