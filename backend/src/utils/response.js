// src/utils/response.js
//
// Issue M2 fix: `created()` previously wasn't imported anywhere — every
// controller called `success(res, data, 201)` directly instead. Removed:
// it's a one-line wrapper that saves near-zero characters over calling
// success() directly, so "wire it in everywhere" would mean touching a
// 201 response in essentially every controller in the codebase for
// negligible readability gain. `paginate()`, by contrast, encodes an
// actual formula (total_pages) that every list endpoint should compute
// identically — that one IS wired in now (see ledger.controller.js,
// dispute.controller.js, container.controller.js, workspace.controller.js,
// notification.controller.js).

function success(res, data, statusCode = 200, meta = null) {
  const body = { data };
  if (meta) body.meta = meta;
  return res.status(statusCode).json(body);
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

module.exports = { success, paginate, noContent };
