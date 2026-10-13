// router/AdminRoute.test.tsx
//
// Gates the workspace admin-only screens (settings, member management,
// etc.) behind the current member's role. Previously untested — this is
// the one guard where getting it wrong means a non-admin member can
// reach admin-only screens, so it's worth a direct, isolated test of
// just the true/false branches rather than only covering it indirectly
// through page-level tests.
//
// useIsAdmin is mocked directly rather than driving the underlying
// workspaceStore, since AdminRoute's only real logic is "trust whatever
// this hook returns" — testing that trust, not useIsAdmin's own
// role-comparison logic (which belongs in its own test if useIsAdmin
// grows more branches later).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AdminRoute } from './AdminRoute';
import { useIsAdmin } from '@/hooks/useIsAdmin';

vi.mock('@/hooks/useIsAdmin', () => ({
  useIsAdmin: vi.fn(),
}));

const mockedUseIsAdmin = vi.mocked(useIsAdmin);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AdminRoute />}>
          <Route path="/app/workspace/settings" element={<div>Admin Settings</div>} />
        </Route>
        <Route path="/app/dashboard" element={<div>Dashboard Content</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('AdminRoute', () => {
  beforeEach(() => {
    mockedUseIsAdmin.mockReset();
  });

  it('renders the admin-only content when the current member is an admin', () => {
    mockedUseIsAdmin.mockReturnValue(true);

    renderAt('/app/workspace/settings');

    expect(screen.getByText('Admin Settings')).toBeInTheDocument();
  });

  it('redirects a non-admin member to the dashboard, never rendering the admin content', () => {
    mockedUseIsAdmin.mockReturnValue(false);

    renderAt('/app/workspace/settings');

    expect(screen.getByText('Dashboard Content')).toBeInTheDocument();
    expect(screen.queryByText('Admin Settings')).not.toBeInTheDocument();
  });
});
