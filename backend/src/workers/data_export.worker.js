// src/workers/data_export.worker.js
//
// Processes 'export-user-data' jobs queued by POST /v1/auth/data-export.
// Fetch/CSV-build/email logic lives in services/data_export.service.js.

const { Worker }   = require('bullmq');
const { getRedis } = require('../config/redis');
const { processDataExport } = require('../services/data_export.service');

function createDataExportWorker() {
  return new Worker(
    'data-export-queue',
    async (job) => processDataExport(job.data),
    {
      connection:  getRedis(),
      concurrency: 2,  // exports are I/O heavy — keep concurrency low
    }
  );
}

module.exports = { createDataExportWorker };
