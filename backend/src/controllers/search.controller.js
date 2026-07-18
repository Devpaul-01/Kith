// src/controllers/search.controller.js
//
// Service-layer refactor: this controller previously contained the
// query-building/escaping/shaping logic directly. That logic now lives in
// services/search.service.js — this file is a thin HTTP adapter: parse
// request, call service, format response, forward errors.

const { success } = require('../utils/response');
const searchService = require('../services/search.service');

async function searchWorkspace(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const { results, query } = await searchService.searchWorkspace({
      workspaceId,
      query: req.query.q,
      limit: req.query.limit,
    });

    success(res, { results, query });
  } catch (err) { next(err); }
}

module.exports = {
  searchWorkspace,
};
