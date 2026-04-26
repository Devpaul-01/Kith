// src/config/resend.js
const { Resend } = require('resend');
const logger = require('../utils/logger');

let resendClient;

function getResend() {
  if (!resendClient) {
    if (!process.env.RESEND_API_KEY) {
      logger.warn('RESEND_API_KEY not set — email notifications disabled');
      return null;
    }
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

module.exports = { getResend };
