// tests/mocks/index.js
module.exports = {
  ...require('./supabase.mock'),
  ...require('./redis.mock'),
  ...require('./firebase.mock'),
  ...require('./resend.mock'),
  ...require('./bullmq.mock'),
};
