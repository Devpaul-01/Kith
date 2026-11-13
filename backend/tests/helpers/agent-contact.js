const { context } = require('./agent-proposal');

const CONTACT_ID = '77777777-abcd-4777-8777-777777777777';
const contactSnapshot = (overrides = {}) => ({
  id: CONTACT_ID, type: 'whatsapp', value: '+2348012345678',
  label: 'Personal', country_code: '+234', is_primary: false,
  is_verified: false, verified_at: null, created_at: '2026-11-13T12:00:00.000Z',
  ...overrides,
});
const contactRow = (overrides = {}) => ({
  ...contactSnapshot(), user_id: context().userId, ...overrides,
});

module.exports = { CONTACT_ID, contactSnapshot, contactRow };
