// src/utils/response.js

const { getPaginationMeta } = require('./pagination');

function success(res, data, statusCode = 200, meta = null) {
  const body = { data };
  if (meta) body.meta = meta;
  return res.status(statusCode).json(body);
}

function paginate(res, data, total, page, perPage) {
  return success(res, data, 200, {
    pagination: getPaginationMeta({ total, page, perPage }),
  });
}

function noContent(res) {
  return res.status(204).send();
}

module.exports = { success, paginate, noContent };
