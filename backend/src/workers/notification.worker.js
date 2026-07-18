// src/workers/notification.worker.js
//
// Service-layer refactor: delivery logic (idempotency, retry bookkeeping,
// FCM/Resend sending, HTML escaping) now lives in
// services/notification_delivery.service.js. This file only wires the
// BullMQ Worker.

const { Worker }   = require('bullmq');
const { getRedis } = require('../config/redis');
const { deliverNotification } = require('../services/notification_delivery.service');

function createNotificationWorker() {
  return new Worker(
    'notification-queue',
    async (job) => deliverNotification(job.data),
    {
      connection:  getRedis(),
      concurrency: 10,
      limiter:     { max: 50, duration: 1000 },
    }
  );
}

module.exports = { createNotificationWorker };
