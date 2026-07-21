// src/controllers/dashboard.controller.js
//
// All aggregation/computation lives in services/dashboard.service.js.
// This file only parses req and responds.

const { success } = require('../utils/response');
const dashboardService = require('../services/dashboard.service');

async function getDashboard(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const isAdmin         = req.member?.role === 'admin';
    const memberId        = req.member?.id;

    const payload = await dashboardService.getDashboardData({ workspaceId, isAdmin, memberId });
    success(res, payload);
  } catch (err) { next(err); }
}

async function getOverdueSummary(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const payload = await dashboardService.getOverdueSummaryData({ workspaceId });
    success(res, payload);
  } catch (err) { next(err); }
}

module.exports = {
  getDashboard,
  getOverdueSummary,
};
