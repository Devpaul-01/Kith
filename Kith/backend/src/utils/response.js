// src/utils/response.js

function success(res, data, statusCode = 200, meta = null) {
  const body = { data };
  if (meta) body.meta = meta;
  return res.status(statusCode).json(body);
}

function created(res, data, meta = null) {
  return success(res, data, 201, meta);
}

function paginate(res, data, total, page, perPage) {
  return success(res, data, 200, {
    pagination: {
      page: parseInt(page),
      per_page: parseInt(perPage),
      total,
      total_pages: Math.ceil(total / perPage),
    },
  });
}

function noContent(res) {
  return res.status(204).send();
}

module.exports = { success, created, paginate, noContent };
