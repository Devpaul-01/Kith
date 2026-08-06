// tests/unit/utils/response.test.js
const { success, paginate, noContent } = require('../../../src/utils/response');

/** Minimal Express-`res`-shaped mock: chainable .status().json()/.send(). */
function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.send = jest.fn(() => res);
  return res;
}

describe('utils/response', () => {
  describe('success', () => {
    it('defaults to status 200 and wraps data in { data }', () => {
      const res = mockRes();
      success(res, { id: 1 });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ data: { id: 1 } });
    });

    it('honors an explicit statusCode', () => {
      const res = mockRes();
      success(res, { id: 1 }, 201);
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('includes meta in the body only when provided', () => {
      const res = mockRes();
      success(res, [1, 2], 200, { pagination: { page: 1 } });
      expect(res.json).toHaveBeenCalledWith({
        data: [1, 2],
        meta: { pagination: { page: 1 } },
      });
    });

    it('omits the meta key entirely when meta is null', () => {
      const res = mockRes();
      success(res, [1, 2], 200, null);
      const body = res.json.mock.calls[0][0];
      expect(body).not.toHaveProperty('meta');
    });
  });

  describe('paginate', () => {
    it('builds the full pagination envelope', () => {
      const res = mockRes();
      paginate(res, [{ id: 1 }], 21, 1, 20);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        data: [{ id: 1 }],
        meta: {
          pagination: { page: 1, per_page: 20, total: 21, total_pages: 2 },
        },
      });
    });

    it('computes total_pages as 0 (not NaN) when total is 0', () => {
      const res = mockRes();
      paginate(res, [], 0, 1, 20);
      const body = res.json.mock.calls[0][0];
      expect(body.meta.pagination.total_pages).toBe(0);
    });

    it('coerces string page/perPage to numbers in the output', () => {
      const res = mockRes();
      paginate(res, [], 10, '2', '5');
      const body = res.json.mock.calls[0][0];
      expect(body.meta.pagination.page).toBe(2);
      expect(body.meta.pagination.per_page).toBe(5);
      expect(typeof body.meta.pagination.page).toBe('number');
      expect(typeof body.meta.pagination.per_page).toBe('number');
    });
  });

  describe('noContent', () => {
    it('responds with 204 and an empty send (no body argument)', () => {
      const res = mockRes();
      noContent(res);
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalledWith();
      expect(res.send.mock.calls[0]).toHaveLength(0);
    });
  });
});
