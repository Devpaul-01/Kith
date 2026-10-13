// router/LandingRoute.test.tsx
//
// The inverse of ProtectedRoute: keeps an already-logged-in user off
// public marketing/login pages by bouncing them into the app. Same
// mocking approach as ProtectedRoute.test.tsx — see that file's header
// for why useAuthStore is mocked at the module level.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { LandingRoute } from './LandingRoute';
import { useAuthStore } from '@/store/authStore';

vi.mock('@/store/authStore', () => ({
  useAuthStore: vi.fn(),
}));

const mockedUseAuthStore = vi.mocked(useAuthStore);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<LandingRoute />}>
          <Route path="/login" element={<div>Login Page</div>} />
        </Route>
        <Route path="/app/dashboard" element={<div>Dashboard Content</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('LandingRoute', () => {
  beforeEach(() => {
    mockedUseAuthStore.mockReset();
  });

  it('renders the public page (e.g. login) when there is no session', () => {
    mockedUseAuthStore.mockImplementation((selector: any) => selector({ session: null }));

    renderAt('/login');

    expect(screen.getByText('Login Page')).toBeInTheDocument();
  });

  it('redirects an already-authenticated user away from the public page to the app', () => {
    mockedUseAuthStore.mockImplementation((selector: any) =>
      selector({ session: { access_token: 'tok', expires_in: 3600 } })
    );

    renderAt('/login');

    expect(screen.getByText('Dashboard Content')).toBeInTheDocument();
    expect(screen.queryByText('Login Page')).not.toBeInTheDocument();
  });
});
