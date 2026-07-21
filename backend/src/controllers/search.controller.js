// src/controllers/search.controller.js
//
// Thin HTTP adapter: parse request, call service, format response,
// forward errors. Query-building/escaping/shaping logic lives in
// services/search.service.js.

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
