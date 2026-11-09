// Two keys in one hash slot: the transcript and its turn lease. Redis owns
// lease expiry; a slow/abandoned request cannot overwrite a newer turn.
const ACQUIRE_CONVERSATION_SCRIPT = `
local payload = redis.call('GET', KEYS[1])
if ARGV[1] == 'create' then
  if payload or redis.call('EXISTS', KEYS[2]) == 1 then return {'exists'} end
  payload = ARGV[3]
  redis.call('SET', KEYS[1], payload, 'EX', ARGV[4])
elseif not payload then
  return {'missing'}
end
if redis.call('EXISTS', KEYS[2]) == 1 then return {'busy'} end
redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[5])
return {'ready', payload}
`;

const COMMIT_CONVERSATION_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return {'lost'} end
if redis.call('EXISTS', KEYS[1]) ~= 1 then
  redis.call('DEL', KEYS[2])
  return {'missing'}
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
redis.call('DEL', KEYS[2])
return {'saved'}
`;

const RELEASE_CONVERSATION_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[2])
if ARGV[2] == 'create' then redis.call('DEL', KEYS[1]) end
return 1
`;

module.exports = { ACQUIRE_CONVERSATION_SCRIPT, COMMIT_CONVERSATION_SCRIPT, RELEASE_CONVERSATION_SCRIPT };
