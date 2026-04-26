// src/utils/crypto.js
const crypto = require('crypto');

function generateToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

function generatePublicToken(length = 16) {
  return crypto.randomBytes(length).toString('base64url');
}

function generateRequestId() {
  return `req_${crypto.randomBytes(8).toString('hex')}`;
}

module.exports = { generateToken, generatePublicToken, generateRequestId };
