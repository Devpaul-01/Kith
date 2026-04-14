# Backend Testing Guide
### Written for your Kith API Codebase

---

## Table of Contents

1. [What Is Testing and Why It Matters](#1-what-is-testing-and-why-it-matters)
2. [Types of Tests](#2-types-of-tests)
3. [Testing Strategy for Your Codebase](#3-testing-strategy-for-your-codebase)
4. [What to Test — Each Layer of Your Codebase](#4-what-to-test--each-layer-of-your-codebase)
5. [How to Write Tests — Step by Step](#5-how-to-write-tests--step-by-step)
6. [Tools and Setup](#6-tools-and-setup)
7. [Real Examples from Your Codebase](#7-real-examples-from-your-codebase)
8. [Common Mistakes to Avoid](#8-common-mistakes-to-avoid)
9. [Interview Perspective](#9-interview-perspective)

---

## 1. What Is Testing and Why It Matters

A **test** is code that you write to verify that other code works correctly. You run a piece of your system, give it some input, and confirm that the output is exactly what you expected.

### Why bother?

Imagine you change the `createEntry` function in your `ledger.controller.js`. It's a complex function — it checks if the contributor is a participant, detects duplicate entries, handles admin vs. member permissions, notifies admins, and writes an audit log. Without tests, the only way to know you didn't break something is to manually click through the app and hope you covered every scenario.

With tests:
- You catch bugs before they reach production
- You can refactor confidently — change internal implementation without fear
- You document exactly how a function is *supposed* to behave
- Code reviews become easier — tests show intent

### The core idea: tests protect you from yourself

As your codebase grows, you will break things without realising it. Tests are the safety net.

---

## 2. Types of Tests

There are three types you need to understand. Each has a different scope and a different purpose.

### Unit Tests

A unit test checks a **single function or module in complete isolation**. All external dependencies (database, other services, HTTP requests) are replaced with fake versions called **mocks**.

**When to use:** Testing pure logic — a helper function, a validator, a permission check, a service calculation.

**Example in your codebase:** Testing `mapSupabaseAuthError()` in `auth.controller.js`. That function takes an error and maps it to your custom error classes. It has no external dependencies — perfect for a unit test. You give it different error messages and verify it returns the right custom error.

**Characteristics:**
- Very fast (milliseconds per test)
- No database required
- Highly targeted — when they fail, you know exactly what broke

### Integration Tests

An integration test checks that **multiple parts of your system work together correctly**. In a Node.js/Express context, this usually means sending a real HTTP request to your app and checking the HTTP response — but the database calls are still mocked.

**When to use:** Testing a full route — from the request hitting your middleware, through the controller, to the response. This is the most valuable type of test for your codebase.

**Example in your codebase:** Testing `POST /v1/workspaces` — you send a request with a valid body, mock Supabase so it returns a fake workspace, and assert you get a `201` with the expected data structure.

**Characteristics:**
- Slower than unit tests
- Tests that your middleware, validation, and controller all connect properly
- When they fail, could be an issue in any of the connected layers (but usually easy to narrow down)

### End-to-End (E2E) Tests

An E2E test runs against your **real, fully running application** — real database, real network. These are expensive to set up and slow to run. They are optional for most teams, especially early on.

**When to use:** Critical user journeys that absolutely cannot fail (e.g., the full signup → login → accept invite → create workspace flow).

For now, focus entirely on unit tests and integration tests. E2E tests can come later once you have good coverage on the other two.

---

### Quick Reference: When to Use Each

| Scenario | Type |
|---|---|
| Testing `mapSupabaseAuthError()` logic | Unit |
| Testing `validateUpload()` in storage service | Unit |
| Testing `requireAdmin` middleware | Unit |
| Testing `renderTemplate()` in notification service | Unit |
| Testing `POST /v1/auth/signup` end-to-end response | Integration |
| Testing `POST /v1/workspaces/:id/containers/:id/ledger` | Integration |
| Testing that a bad JWT returns 401 | Integration |
| Testing that a non-admin gets 403 on an admin route | Integration |
| Testing the full signup → login flow on a real DB | E2E |

---

## 3. Testing Strategy for Your Codebase

Not everything needs to be tested equally. Here is how to prioritise based on your codebase.

### High Priority — Test These First

These are the parts of your system where a bug has the most damaging consequences.

**1. Middleware (`auth.js`, `workspace.js`, `role.js`)**

Your entire security model lives here. `requireAuth`, `loadDbUser`, `requireMembership`, and `requireAdmin` are called on almost every route. A bug here means either:
- Authenticated users can't access anything (the app is broken), or
- Unauthenticated users can access everything (a security breach)

**2. Ledger Controller (`ledger.controller.js`)**

This controller handles money. It has complex rules:
- Only participants can contribute
- Non-admins can only record for themselves
- Duplicate detection within 10 minutes
- Status transitions (pending → proof_uploaded → confirmed)
- Admin auto-confirm vs. pending for regular members

A bug here could cause financial data to be corrupted. Test it thoroughly.

**3. Dispute Controller (`dispute_controller.js`)**

Disputes change ledger entry statuses and send urgent notifications. Bugs here can leave entries in incorrect states.

**4. `mapSupabaseAuthError()` in `auth.controller.js`**

This function decides what error message a user sees when login fails. If it maps incorrectly, users might see cryptic messages or, worse, get wrong guidance.

**5. `validateUpload()` in `storage.service.js`**

Pure logic with no external dependencies. Enforces file size and type rules. Easy to test, high security value.

**6. `renderTemplate()` and `buildDedupKey()` in `notification.service.js`**

These are pure functions. They're called every time a notification is sent. A bug in `renderTemplate` means every notification in your app shows broken text to users.

---

### Medium Priority

**7. `errorHandler` middleware**

It processes Zod errors, AppErrors, and Postgres errors. You want to confirm each case maps to the right HTTP status and response shape.

**8. Workspace Controller (create, update, delete)**

Complex side effects: creating a workspace also creates the creator as an admin member AND seeds default settings. Testing these multi-step operations catches omissions.

**9. Invite Controller**

The `acceptInvite` function does several things in sequence (validates token, checks expiry, checks existing membership, creates member, marks invite used, notifies admins). If any step fails silently, the state becomes inconsistent.

**10. `exportLedgerCSV` in `export.service.js`**

Pure transformation logic — fetches data and maps it to CSV rows. Easy to test with mocked data.

---

### Lower Priority (For Now)

- **Background workers** (`background_workers.js`) — important but complex to test; tackle after good coverage on the above
- **Notification delivery logic** — the queue mechanics are handled by BullMQ, which you don't own
- **`audit.service.js`** — fire-and-forget, never throws; low risk
- **Routes files** — these just wire middleware to controllers; the integration tests already cover them

---

## 4. What to Test — Each Layer of Your Codebase

### Routes

Routes in your codebase (`workspace.routes.js`, `auth.routes.js`, etc.) primarily wire middleware to controllers. You do not test route files directly. Instead, you test them **indirectly through integration tests** that hit the full HTTP layer.

What you're really checking at the route level:
- Is the correct middleware applied? (e.g., does this route require `requireAdmin`?)
- Does the correct controller function get called?
- Does an unauthenticated request get rejected?

**What could go wrong if not tested:** A route that should be admin-only accidentally doesn't apply `requireAdmin`, allowing any member to call it.

---

### Middleware

Your middleware is the gatekeeper. It is shared across many routes, so a bug is amplified.

**`requireAuth` — What to test:**
- No `Authorization` header → 401
- Header doesn't start with `Bearer ` → 401
- Token is invalid / Supabase returns an error → 401
- Valid token → `req.user` is set correctly, `next()` is called

**`loadDbUser` — What to test:**
- `req.user` is not set → 401
- User found in DB → `req.dbUser` is set, `next()` is called
- User not found (deleted or never registered) → 401 with correct message

**`requireMembership` — What to test:**
- User is not a member of the workspace → 404 (your code intentionally returns 404, not 403, to prevent workspace enumeration)
- User is a member but `is_active` is false → 404
- User is a valid active member → `req.member` and `req.workspace` are attached correctly

**`requireAdmin` — What to test:**
- `req.member.role` is `'member'` → 403
- `req.member.role` is `'admin'` → `next()` is called
- `req.member` is undefined → 403

**Why it matters:** Every protected route in your app depends on this chain working correctly.

---

### Controllers

Controllers contain the bulk of your business logic. This is where you write the most tests.

For each controller function, ask yourself:

**What are all the ways this can go wrong?**
- Invalid input (Zod will catch this — does it return 400 with the right field?)
- Resource not found — does it return 404?
- Permission violation — does it return 403?
- Business rule violation — does it return the correct code?
- Duplicate/conflict — does it return 409?

**What is the happy path?**
- Valid input, user has permission → does it return the right status code and data shape?

**What side effects should occur?**
- Does it call `notification.send()`?
- Does it call `audit.log()`?
- Does it write the correct data to the database?

**Example — `createEntry` in `ledger.controller.js`:**

Test cases you should write:
1. Non-admin tries to create an entry for another member → 403
2. Contributor is not a participant in the container → 422 (BusinessRuleError)
3. Duplicate entry within 10 minutes, `force` not set → 409
4. Duplicate entry within 10 minutes, `?force=true` → 201 (override works)
5. Regular member creates entry → status is `pending`, notification is sent to admins
6. Admin creates entry → status is `confirmed`, no pending notification
7. Proxy member entry → admin-only rule is enforced

---

### Services

Services are either pure logic or thin wrappers around external systems.

**Pure logic (test with unit tests):**
- `validateUpload()` in `storage.service.js`
- `renderTemplate()` in `notification.service.js`
- `buildDedupKey()` in `notification.service.js`
- `exportLedgerCSV()` row mapping logic (you can test the transformation without testing Supabase)

**What to test in `validateUpload()`:**
- Known file type, size within limit, allowed content type → no error thrown
- Unknown file type → throws `BusinessRuleError`
- File exceeds size limit → throws `BusinessRuleError` with correct message
- Content type not in allowed list → throws `BusinessRuleError`

**What to test in `renderTemplate()`:**
- Template `"Hi {name}, your {amount} is due"` + variables `{name: 'Alice', amount: '£50'}` → returns `"Hi Alice, your £50 is due"`
- Variable not present in template → variable placeholder is replaced with empty string
- Variables object is empty → all placeholders become empty strings

---

### Database Logic

Your codebase uses Supabase directly in controllers (there's no separate repository/data-access layer). This is normal, but it means you cannot easily test database logic without mocking Supabase.

For integration tests, you will **mock the entire Supabase client**. Your tests do not hit a real database. This keeps tests fast and predictable.

What you verify about database logic:
- Was Supabase called with the correct table name and filters?
- When Supabase returns an error, does the controller handle it correctly?
- When Supabase returns null/empty, does the controller throw the right error?

You are not testing that Supabase works — you trust it to. You are testing that **your code** handles Supabase's responses correctly.

---

## 5. How to Write Tests — Step by Step

### The Mindset

Before you write a single line of test code, ask yourself:

**"What behaviour am I verifying?"**

Not: "What code am I covering?" — that's the wrong way to think about it. You are verifying **behaviour from the outside**, the same way a real user or API consumer would experience it.

---

### The AAA Pattern

Every test you write follows this exact three-part structure:

**Arrange** — Set up the world. Create the inputs, mocks, and preconditions needed.

**Act** — Run the thing you're testing. Call the function, or send the HTTP request.

**Assert** — Check that the outcome is exactly what you expected.

This structure makes tests readable. Anyone looking at your test can immediately find the three sections.

```javascript
test('should return 403 when non-admin tries to delete a workspace', async () => {
  // ── ARRANGE ──────────────────────────────────────────────────────
  // Mock the auth middleware to inject a non-admin member
  mockRequireAuth({ userId: 'user-123' });
  mockRequireMembership({ memberId: 'member-456', role: 'member' });

  // ── ACT ──────────────────────────────────────────────────────────
  const response = await request(app)
    .delete('/v1/workspaces/ws-abc')
    .set('Authorization', 'Bearer fake-token');

  // ── ASSERT ───────────────────────────────────────────────────────
  expect(response.status).toBe(403);
  expect(response.body.error.code).toBe('FORBIDDEN');
});
```

---

### What Does a Good Test Look Like?

A good test is:

**Readable** — The test name clearly explains the scenario. If the test fails, the name tells you exactly what broke. Use the format: `should [expected behaviour] when [condition]`.

**Isolated** — It does not depend on another test having run first. Every test sets up its own state.

**Deterministic** — It passes every time you run it, not sometimes. No relying on the current date or network.

**Focused** — It tests exactly one thing. If it fails, you know what broke without having to investigate.

**A bad test name:** `test('ledger entry creation')`

**A good test name:** `test('should return 409 when a duplicate entry exists within 10 minutes and force is not set')`

---

### Structuring Your Test Files

Mirror your source directory structure. If your code lives at `src/controllers/ledger.controller.js`, the test lives at `tests/controllers/ledger.controller.test.js`.

```
src/
  controllers/
    ledger.controller.js
    auth.controller.js
  middleware/
    auth.js
  services/
    storage.service.js
    notification.service.js

tests/
  controllers/
    ledger.controller.test.js
    auth.controller.test.js
  middleware/
    auth.test.js
  services/
    storage.service.test.js
    notification.service.test.js
```

---

### How Mocking Works

Your controllers depend on `supabaseAdmin` from `'../config/supabase'`. In tests, you replace the real Supabase client with a fake one that returns whatever you tell it to.

This is called **mocking a dependency**. The idea is simple: instead of the real function, you substitute a fake function that you control.

In Jest, you use `jest.mock()` at the top of your test file to intercept an entire module:

```javascript
// Tell Jest to replace the entire supabase config module with a mock
jest.mock('../config/supabase');

// Now import the mock so you can control what it returns
const { supabaseAdmin } = require('../config/supabase');
```

Then in each test, you tell the mock what to return:

```javascript
// Make Supabase pretend to return a workspace successfully
supabaseAdmin.from.mockReturnValue({
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  is: jest.fn().mockReturnThis(),
  maybeSingle: jest.fn().mockResolvedValue({
    data: { id: 'ws-123', name: 'Test Workspace' },
    error: null
  })
});
```

This looks verbose at first. You will get used to it.

---

## 6. Tools and Setup

### Recommended Tools

**Jest** — The testing framework. It runs your tests, provides `expect()` assertions, and handles mocking. It is the industry standard for Node.js backends.

**Supertest** — A library that lets you send real HTTP requests to your Express app without starting a server. Perfect for integration tests.

**Both are well-supported, well-documented, and designed to work together.**

---

### Installation

```bash
npm install --save-dev jest supertest
```

If you use ES modules or want better mock support, also install:

```bash
npm install --save-dev @jest/globals
```

---

### Configure Jest in `package.json`

Add this to your `package.json`:

```json
{
  "scripts": {
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage"
  },
  "jest": {
    "testEnvironment": "node",
    "testMatch": ["**/tests/**/*.test.js"],
    "coverageDirectory": "coverage",
    "collectCoverageFrom": [
      "src/**/*.js",
      "!src/server.js"
    ]
  }
}
```

---

### Setting Up a Test Entry Point

Create a file `tests/setup.js` where you handle things that need to run before every test suite:

```javascript
// tests/setup.js

// Silence console.log in tests (your auth.js has many console.logs)
// Comment this out when debugging
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.FRONTEND_URL = 'http://localhost:3000';
```

Then reference it in your Jest config:

```json
"jest": {
  "setupFilesAfterFramework": ["./tests/setup.js"]
}
```

---

### Running Tests

```bash
# Run all tests once
npm test

# Run tests and re-run when files change (great during development)
npm run test:watch

# Run tests and show how much of your code is covered
npm run test:coverage

# Run a specific test file
npx jest tests/middleware/auth.test.js

# Run tests whose names match a pattern
npx jest --testNamePattern="requireAdmin"
```

---

## 7. Real Examples from Your Codebase

The following examples show you **how to think about and structure tests** for specific parts of your code. They are not complete — they are demonstrations of the approach.

---

### Example 1: Unit Testing `validateUpload()` from `storage.service.js`

This is the best place to start. It's a pure function with no external dependencies. No mocking needed at all.

```javascript
// tests/services/storage.service.test.js

const { validateUpload } = require('../../src/services/storage.service');
const { BusinessRuleError } = require('../../src/utils/errors');

describe('validateUpload', () => {

  describe('when the file type is unknown', () => {
    test('should throw BusinessRuleError', () => {
      // ARRANGE
      const fileType    = 'unknown_type';
      const contentType = 'image/jpeg';
      const fileSize    = 1024;

      // ACT & ASSERT (for functions that throw, you wrap the call)
      expect(() => {
        validateUpload(fileType, contentType, fileSize);
      }).toThrow(BusinessRuleError);

      expect(() => {
        validateUpload(fileType, contentType, fileSize);
      }).toThrow('Unknown file type: unknown_type');
    });
  });

  describe('when the file exceeds the size limit', () => {
    test('should throw BusinessRuleError for avatar over 5MB', () => {
      // ARRANGE
      const fileType    = 'avatar';
      const contentType = 'image/jpeg';
      const fileSize    = 6 * 1024 * 1024; // 6MB — over the 5MB limit

      // ACT & ASSERT
      expect(() => {
        validateUpload(fileType, contentType, fileSize);
      }).toThrow(BusinessRuleError);
    });

    test('should NOT throw for avatar exactly at 5MB', () => {
      // ARRANGE
      const fileType    = 'avatar';
      const contentType = 'image/jpeg';
      const fileSize    = 5 * 1024 * 1024; // exactly 5MB

      // ACT & ASSERT — we expect this NOT to throw
      expect(() => {
        validateUpload(fileType, contentType, fileSize);
      }).not.toThrow();
    });
  });

  describe('when content type is not allowed', () => {
    test('should throw for pdf avatar (pdf not in avatar allowed types)', () => {
      // ARRANGE
      const fileType    = 'avatar';
      const contentType = 'application/pdf'; // not allowed for avatar
      const fileSize    = 1024;

      // ACT & ASSERT
      expect(() => {
        validateUpload(fileType, contentType, fileSize);
      }).toThrow(BusinessRuleError);
    });

    test('should NOT throw for valid proof with pdf content type', () => {
      // ARRANGE — 'proof' type does allow application/pdf
      const fileType    = 'proof';
      const contentType = 'application/pdf';
      const fileSize    = 1024;

      // ACT & ASSERT
      expect(() => {
        validateUpload(fileType, contentType, fileSize);
      }).not.toThrow();
    });
  });

});
```

**Why this is a good set of tests:** Each test is one scenario. The names describe exactly what they check. There are no external dependencies. Boundary cases (exactly at limit) are covered.

---

### Example 2: Unit Testing `renderTemplate()` from `notification.service.js`

The function `renderTemplate` is not exported in your current code. This is worth noting: **if a function has logic worth testing, consider exporting it** even if it's currently private. For now, here's the approach if you add the export:

```javascript
// tests/services/notification.service.test.js

// Note: you'd need to export renderTemplate from notification.service.js first
const { renderTemplate } = require('../../src/services/notification.service');

describe('renderTemplate', () => {

  test('should replace all variable placeholders with values', () => {
    // ARRANGE
    const template  = '{actor} submitted {amount} for {container}';
    const variables = { actor: 'Alice', amount: '£100', container: 'Wedding Fund' };

    // ACT
    const result = renderTemplate(template, variables);

    // ASSERT
    expect(result).toBe('Alice submitted £100 for Wedding Fund');
  });

  test('should replace missing variables with an empty string', () => {
    // ARRANGE
    const template  = 'Hi {name}, your {amount} is due';
    const variables = { name: 'Bob' }; // amount is missing

    // ACT
    const result = renderTemplate(template, variables);

    // ASSERT
    expect(result).toBe('Hi Bob, your  is due');
  });

  test('should handle null variable values gracefully', () => {
    // ARRANGE
    const template  = 'Hello {name}';
    const variables = { name: null };

    // ACT
    const result = renderTemplate(template, variables);

    // ASSERT
    expect(result).toBe('Hello ');
  });

});
```

---

### Example 3: Unit Testing `requireAdmin` Middleware

```javascript
// tests/middleware/role.test.js

const { requireAdmin } = require('../../src/middleware/role');
const { ForbiddenError } = require('../../src/utils/errors');

describe('requireAdmin', () => {

  // Helpers — fake Express req, res, next
  function makeReq(memberRole) {
    return { member: { role: memberRole, id: 'member-123' } };
  }
  const res  = {}; // not used by requireAdmin
  const next = jest.fn(); // capture what's passed to next()

  beforeEach(() => {
    next.mockClear(); // reset the mock before each test
  });

  test('should call next() without error when member is admin', () => {
    // ARRANGE
    const req = makeReq('admin');

    // ACT
    requireAdmin(req, res, next);

    // ASSERT
    expect(next).toHaveBeenCalledWith(); // called with no arguments = success
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('should call next(ForbiddenError) when member is not admin', () => {
    // ARRANGE
    const req = makeReq('member');

    // ACT
    requireAdmin(req, res, next);

    // ASSERT
    expect(next).toHaveBeenCalledTimes(1);
    const errorPassedToNext = next.mock.calls[0][0]; // first argument of first call
    expect(errorPassedToNext).toBeInstanceOf(ForbiddenError);
    expect(errorPassedToNext.message).toBe('Admin access required');
  });

  test('should call next(ForbiddenError) when req.member is not set', () => {
    // ARRANGE
    const req = { member: null }; // no member

    // ACT
    requireAdmin(req, res, next);

    // ASSERT
    const errorPassedToNext = next.mock.calls[0][0];
    expect(errorPassedToNext).toBeInstanceOf(ForbiddenError);
  });

});
```

---

### Example 4: Integration Test for `POST /v1/workspaces`

This tests the full request-response cycle. You use Supertest to send the request and mock Supabase to control the database responses.

```javascript
// tests/controllers/workspace.controller.test.js

const request    = require('supertest');
const app        = require('../../src/app');

// Mock all external dependencies
jest.mock('../../src/config/supabase');
jest.mock('../../src/middleware/auth'); // mock the auth middleware too
jest.mock('../../src/middleware/workspace');

const { supabaseAdmin }    = require('../../src/config/supabase');
const { requireAuth, loadDbUser } = require('../../src/middleware/auth');

// Make requireAuth and loadDbUser just call next() and set req.user
beforeEach(() => {
  requireAuth.mockImplementation((req, res, next) => {
    req.user = { id: 'user-123', email: 'test@example.com' };
    next();
  });
  loadDbUser.mockImplementation((req, res, next) => {
    req.dbUser = { id: 'user-123', full_name: 'Alice Test' };
    next();
  });
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('POST /v1/workspaces', () => {

  test('should create a workspace and return 201 with workspace and member', async () => {
    // ARRANGE — control what Supabase returns
    const fakeWorkspace = { id: 'ws-abc', name: 'Test Family', base_currency: 'GBP' };
    const fakeMember    = { id: 'mem-xyz', role: 'admin', workspace_id: 'ws-abc' };
    const fakeUser      = { full_name: 'Alice Test' };

    // Mock the chain of Supabase calls inside createWorkspace
    // First call: insert workspace
    // Second call: get user display name
    // Third call: insert member
    // Fourth call: insert default settings (3 rows)
    supabaseAdmin.from.mockImplementation((table) => {
      if (table === 'workspaces') {
        return {
          insert: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({ data: fakeWorkspace, error: null }),
        };
      }
      if (table === 'users') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({ data: fakeUser, error: null }),
        };
      }
      if (table === 'workspace_members') {
        return {
          insert: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({ data: fakeMember, error: null }),
        };
      }
      if (table === 'workspace_settings') {
        return {
          insert: jest.fn().mockResolvedValue({ data: null, error: null }),
        };
      }
    });

    // ACT
    const response = await request(app)
      .post('/v1/workspaces')
      .set('Authorization', 'Bearer fake-token')
      .send({ name: 'Test Family', base_currency: 'GBP', family_type: 'immediate' });

    // ASSERT
    expect(response.status).toBe(201);
    expect(response.body.data.workspace.id).toBe('ws-abc');
    expect(response.body.data.member.role).toBe('admin');
  });

  test('should return 400 when name is missing', async () => {
    // ARRANGE — body is intentionally invalid (missing required 'name')

    // ACT
    const response = await request(app)
      .post('/v1/workspaces')
      .set('Authorization', 'Bearer fake-token')
      .send({ base_currency: 'GBP' }); // missing 'name'

    // ASSERT
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

});
```

**Note:** Mocking Supabase's fluent chain API (`.from().select().eq().single()`) is the trickiest part of writing tests for your codebase. It takes practice. Start with the simpler unit tests first, then come back to integration tests once you're comfortable.

---

### Example 5: Integration Test Showing Auth Protection

This is a very valuable pattern — verifying that protected routes actually reject unauthenticated requests.

```javascript
// tests/routes/workspace.routes.test.js

const request = require('supertest');
const app     = require('../../src/app');

// Don't mock requireAuth — test that real auth rejection works
jest.mock('../../src/config/supabase');
const { supabaseAdmin } = require('../../src/config/supabase');

describe('Workspace routes — authentication enforcement', () => {

  test('should return 401 for DELETE /v1/workspaces/:id with no token', async () => {
    // ACT — no Authorization header
    const response = await request(app)
      .delete('/v1/workspaces/ws-123');

    // ASSERT
    expect(response.status).toBe(401);
  });

  test('should return 401 for GET /v1/workspaces with an invalid token', async () => {
    // ARRANGE — mock Supabase to simulate invalid token
    supabaseAdmin.auth = {
      getUser: jest.fn().mockResolvedValue({
        data: { user: null },
        error: { message: 'Invalid JWT', status: 401 }
      })
    };

    // ACT
    const response = await request(app)
      .get('/v1/workspaces')
      .set('Authorization', 'Bearer invalid-token');

    // ASSERT
    expect(response.status).toBe(401);
  });

});
```

---

## 8. Common Mistakes to Avoid

### Testing implementation instead of behaviour

**Wrong thinking:** "I want to make sure `supabaseAdmin.from('users').update()` was called."

**Right thinking:** "I want to make sure that when I update a profile, the response contains the updated user data."

Test what comes out, not what happens inside. If you refactor internal implementation, tests that check behaviour will still pass. Tests that check internal calls will break even when nothing is wrong.

---

### Writing tests that always pass

A test that never fails is not a test — it's noise. Every test you write should be capable of detecting a real bug. After writing a test, ask yourself: "If I deleted the relevant code from the controller, would this test fail?" If not, rewrite it.

---

### Skipping the failure cases

Beginners often only test the happy path (valid input, everything works). The most valuable tests are the **failure cases** — what happens when input is invalid, a resource is not found, or a permission is denied. Most bugs live in error-handling code.

---

### Not cleaning up mocks between tests

If you set a mock in one test and don't reset it, the next test inherits that mock state. Always use `afterEach(() => jest.clearAllMocks())` at the top of every test file that uses mocks.

---

### One giant test instead of several focused ones

**Wrong:**
```javascript
test('ledger entry creation', async () => {
  // tests happy path
  // then also tests duplicate detection
  // then also tests permission
  // ...50 lines later
});
```

**Right:**
```javascript
test('should return 201 for valid admin entry', ...);
test('should return 409 for duplicate within 10 minutes', ...);
test('should return 403 when member creates entry for another member', ...);
```

When a single large test fails, you don't know which behaviour broke. When small focused tests fail, the test name tells you exactly what broke.

---

### Mocking too much

If you mock so much that your test doesn't actually run any real code, you're testing the mock, not your app. Strike the balance: mock external services (Supabase, Redis), but let your actual business logic run.

---

### Forgetting about `console.log` noise in tests

Your codebase has a significant amount of `console.log` statements (especially in `auth.js` and `workspace_controller.js`). These will make your test output hard to read. Suppress them in `tests/setup.js` during test runs.

---

### Matching on exact error messages (brittle)

**Fragile:**
```javascript
expect(error.message).toBe('Missing or malformed Authorization header');
```

**Better:**
```javascript
expect(response.status).toBe(401);
expect(response.body.error.code).toBe('UNAUTHORIZED');
```

Error messages change. Status codes and error codes are part of your API contract and change less often.

---

## 9. Interview Perspective

### What interviewers actually want to hear

Interviewers rarely ask you to write a full test suite on the spot. More often they ask conceptual and behavioural questions. Here is what they're looking for:

**"Do you understand why we test?"**

The answer they want is not "to make sure the code works." It's: "To give confidence when changing code, to catch regressions, to document intended behaviour, and to reduce reliance on manual QA."

**"What's the difference between unit tests and integration tests?"**

You should be able to explain this clearly in two sentences each. Use a concrete example from your own project.

**"How do you test code that talks to a database?"**

This is a direct test of practical knowledge. The answer is mocking — you replace the real database client with a controlled fake. You are testing your business logic, not the database driver.

**"How do you decide what to test first?"**

Talk about risk and criticality. Test the things that, if they break, hurt users the most. For your app: authentication middleware, money-related logic, and permission enforcement.

---

### How to talk about your testing approach confidently

Use this structure when explaining your testing strategy in an interview:

**"For this project, I focused on three areas..."**

1. **Security-critical middleware** — `requireAuth`, `requireMembership`, and `requireAdmin` are tested to ensure that unauthenticated requests are rejected and that role-based access control is enforced correctly.

2. **Business-critical controllers** — The ledger controller handles financial data, so I tested all permission rules, the duplicate detection logic, and the status transition from pending to confirmed.

3. **Pure service functions** — Functions like `validateUpload` and `renderTemplate` have no external dependencies, so they're tested with simple unit tests covering happy paths and all documented constraints.

**"I use Jest for the test framework and Supertest for HTTP-layer integration tests. External dependencies like Supabase are mocked so tests run fast and deterministically without a real database."**

---

### Questions you might be asked — and how to think through them

**"How do you test that a non-admin can't access an admin route?"**
→ Write an integration test. Mock `requireMembership` to inject a `role: 'member'` into `req.member`. Hit the admin-only route. Assert the response is 403.

**"Your controller calls both a database update AND sends a notification. How do you test that both happen?"**
→ Mock both dependencies. After the Act step, use `expect(supabaseAdmin.from).toHaveBeenCalledWith('ledger_entries')` to verify the DB was called, and `expect(notificationService.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'contribution_confirmed' }))` to verify the notification was triggered.

**"What's your test coverage? How much is enough?"**
→ Coverage percentage is a metric, not a goal. 100% coverage can be meaningless if the tests don't assert meaningful behaviour. A better answer: "I focus on covering all the distinct outcomes — every HTTP status code a route can return, every business rule violation, and every permission check."

**"What's a test you wrote that caught a real bug?"**
→ Refer to the duplicate detection logic in `createEntry`. A test that sends two identical requests within 10 minutes and checks for a 409 would catch any regression where the deduplication window is accidentally removed or the `force` override stops working.

---

## Summary Checklist

Before you write your first test, use this to orient yourself:

- [ ] Install `jest` and `supertest` as dev dependencies
- [ ] Configure Jest in `package.json`
- [ ] Create `tests/setup.js` to silence console noise and set env vars
- [ ] Start with the easiest wins: `validateUpload` and `renderTemplate` (pure functions)
- [ ] Move to middleware: `requireAdmin` (no mocking needed, just fake req/res/next)
- [ ] Then move to integration tests: `POST /v1/workspaces` or `POST /v1/auth/signup`
- [ ] Use the AAA pattern in every test (Arrange, Act, Assert)
- [ ] Write both the happy path and all the documented failure paths
- [ ] Call `jest.clearAllMocks()` in `afterEach` in every file that uses mocks
- [ ] Name tests as: `"should [expected result] when [condition]"`
