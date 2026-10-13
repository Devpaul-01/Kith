// router/ProtectedRoute.test.tsx
//
// Gates every /app/* route behind having a session. Previously
// untested — a broken guard here is either a security hole (unauth'd
// users reaching protected pages) or a full app lockout (everyone
// bounced to /login), so it's cheap-but-high-value to pin down.
//
// useAuthStore is mocked at the module level rather than driven through
// real Zustand state, since it's wrapped in zustand/middleware's
// `persist` (backed by localStorage) — mocking the hook directly avoids
// coupling this test to persistence/storage behavior that's orthogonal
// to what ProtectedRoute itself does with the session value.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ProtectedRoute } from './ProtectedRoute';
import { useAuthStore } from '@/store/authStore';

vi.mock('@/store/authStore', () => ({
  useAuthStore: vi.fn(),
}));

const mockedUseAuthStore = vi.mocked(useAuthStore);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/app/dashboard" element={<div>Dashboard Content</div>} />
        </Route>
        <Route path="/login" element={<div>Login Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('ProtectedRoute', () => {
  beforeEach(() => {
    mockedUseAuthStore.mockReset();
  });

  it('renders the protected content when a session exists', () => {
    mockedUseAuthStore.mockImplementation((selector: any) =>
      selector({ session: { access_token: 'tok', expires_in: 3600 } })
    );

    renderAt('/app/dashboard');

    expect(screen.getByText('Dashboard Content')).toBeInTheDocument();
  });

  it('redirects to /login when there is no session', () => {
    mockedUseAuthStore.mockImplementation((selector: any) => selector({ session: null }));

    renderAt('/app/dashboard');

    expect(screen.getByText('Login Page')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard Content')).not.toBeInTheDocument();
  });
});
