// One hash per workspace/window. All changes are atomic within Redis.
// Pending reservations remain charged until a known outcome replaces them.
const RESERVE_SCRIPT = `
local function integer(n) return n and n >= 0 and n <= 9007199254740991.0 and n == math.floor(n) end
local function text(n) return string.format('%.0f', n) end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000.0 + math.floor(tonumber(clock[2]) / 1000.0)
local start_at = tonumber(ARGV[1])
local reset_at = tonumber(ARGV[2])
local requested_limit = tonumber(ARGV[3])
local amount = tonumber(ARGV[4])
local field = 'r:' .. ARGV[5]
local expires_at = tonumber(ARGV[6])
if now < start_at or now >= reset_at then return {'stale', text(now)} end

local raw = redis.call('HMGET', KEYS[1], 'used', 'limit', 'blocked')
local used = 0
local limit = requested_limit
if raw[1] then used = tonumber(raw[1]) end
if raw[2] then limit = tonumber(raw[2]) end
if not integer(used) or not integer(limit) or limit < 1 then return {'invalid'} end
if raw[3] and raw[3] ~= '1' then return {'invalid'} end
if (raw[1] and not raw[2]) or (raw[2] and not raw[1]) then return {'invalid'} end
-- A rolling deployment cannot raise the active window's stored allowance.
limit = math.min(limit, requested_limit)
redis.call('HSET', KEYS[1], 'used', text(used), 'limit', text(limit))
redis.call('PEXPIREAT', KEYS[1], expires_at)
if raw[3] then return {'blocked'} end

local previous = redis.call('HGET', KEYS[1], field)
if previous then
  local pending = tonumber(string.match(previous, '^p:(%d+)$'))
  if pending then
    if pending ~= amount then return {'invalid'} end
    return {'reserved', text(used), text(limit)}
  end
  if string.match(previous, '^s:%d+$') then return {'settled'} end
  return {'invalid'}
end
if amount > limit then return {'too_large'} end
if used >= limit or used + amount > limit then return {'exhausted'} end
redis.call('HSET', KEYS[1], 'used', text(used + amount), field, 'p:' .. text(amount))
return {'reserved', text(used + amount), text(limit)}
`;

const SETTLE_SCRIPT = `
local function integer(n) return n and n >= 0 and n <= 9007199254740991.0 and n == math.floor(n) end
local function text(n) return string.format('%.0f', n) end
local field = 'r:' .. ARGV[1]
local previous = redis.call('HGET', KEYS[1], field)
if not previous then return {'missing'} end
local used = tonumber(redis.call('HGET', KEYS[1], 'used'))
if not integer(used) then return {'invalid'} end
local settled = tonumber(string.match(previous, '^s:(%d+)$'))
if settled then
  if not integer(settled) then return {'invalid'} end
  return {'settled', text(used), text(settled)}
end
local pending = tonumber(string.match(previous, '^p:(%d+)$'))
if not integer(pending) or used < pending then return {'invalid'} end
-- Unknown usage keeps its reservation; later known usage may reconcile it.
if ARGV[2] == '' then return {'held', text(used), text(pending)} end
local actual = tonumber(ARGV[2])
if not integer(actual) then return {'invalid'} end
local next_used = used - pending + actual
if not integer(next_used) then
  redis.call('HSET', KEYS[1], 'blocked', '1')
  return {'blocked'}
end
redis.call('HSET', KEYS[1], 'used', text(next_used), field, 's:' .. text(actual))
return {'settled', text(next_used), text(actual)}
`;

module.exports = { RESERVE_SCRIPT, SETTLE_SCRIPT };
