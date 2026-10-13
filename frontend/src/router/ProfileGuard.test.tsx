// router/ProfileGuard.test.tsx
//
// Gates /app/* behind having completed the users-table profile row
// (distinct from merely having a Supabase Auth session — see
// auth.service's getMe/register split). Previously untested, and the
// one guard with its own internal loading state — the branch most
// likely to regress into either a stuck spinner or a flash of the
// wrong content on a refactor.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ProfileGuard } from './ProfileGuard';
import { useAuthStore } from '@/store/authStore';
import { authService } from '@/services/auth.service';
import type { User, Membership } from '@/types/models';

vi.mock('@/store/authStore', () => ({
  useAuthStore: vi.fn(),
}));

vi.mock('@/services/auth.service', () => ({
  authService: { getMe: vi.fn() },
}));

const mockedUseAuthStore = vi.mocked(useAuthStore);
const mockedGetMe = vi.mocked(authService.getMe);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<ProfileGuard />}>
          <Route path="/app/dashboard" element={<div>Dashboard Content</div>} />
        </Route>
        <Route path="/register" element={<div>Register Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('ProfileGuard', () => {
  beforeEach(() => {
    mockedUseAuthStore.mockReset();
    mockedGetMe.mockReset();
  });

  it('renders the protected content immediately when dbUser is already loaded (no fetch, no spinner)', () => {
    mockedUseAuthStore.mockReturnValue({
      dbUser: { id: 'u1', full_name: 'Alice' },
      session: { access_token: 'tok', expires_in: 3600 },
      setDbUser: vi.fn(),
    });

    renderAt('/app/dashboard');

    expect(screen.getByText('Dashboard Content')).toBeInTheDocument();
    expect(mockedGetMe).not.toHaveBeenCalled();
  });

  it('shows a loading state, then fetches and renders the content once dbUser resolves', async () => {
    // A static mockReturnValue won't do here: after setDbUser is called,
    // ProfileGuard needs to see dbUser actually change on its next
    // render, same as real Zustand state would. This fake hook backs
    // dbUser with real React state so calling setDbUser re-renders
    // subscribers, without pulling in the real persisted store.
    const user: User = { id: 'u1', full_name: 'Alice' } as User;
    function useFakeAuthStore() {
      const [dbUser, setDbUserState] = useState<User | null>(null);
      return {
        dbUser,
        session: { access_token: 'tok', expires_in: 3600 },
        setDbUser: (u: User | null, _m: Membership[]) => setDbUserState(u),
      };
    }
    mockedUseAuthStore.mockImplementation(useFakeAuthStore as any);
    mockedGetMe.mockResolvedValue({ user, memberships: [] });

    renderAt('/app/dashboard');

    // Transient loading state before the fetch resolves
    expect(screen.queryByText('Dashboard Content')).not.toBeInTheDocument();
    expect(screen.queryByText('Register Page')).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('Dashboard Content')).toBeInTheDocument());
  });

  it('calls setDbUser with the fetched user and memberships once getMe resolves', async () => {
    const setDbUser = vi.fn();
    mockedUseAuthStore.mockReturnValue({
      dbUser: null,
      session: { access_token: 'tok', expires_in: 3600 },
      setDbUser,
    });
    const user = { id: 'u1', full_name: 'Alice' };
    const memberships = [{ workspace_id: 'ws-1', role: 'admin' }];
    mockedGetMe.mockResolvedValue({ user, memberships });

    renderAt('/app/dashboard');

    await waitFor(() => expect(setDbUser).toHaveBeenCalledWith(user, memberships));
  });

  it('redirects to /register if getMe resolves but there is still no dbUser (profile incomplete)', async () => {
    mockedUseAuthStore.mockReturnValue({
      dbUser: null,
      session: { access_token: 'tok', expires_in: 3600 },
      setDbUser: vi.fn(),
    });
    mockedGetMe.mockResolvedValue({ user: null, memberships: [] });

    renderAt('/app/dashboard');

    await waitFor(() => expect(screen.getByText('Register Page')).toBeInTheDocument());
  });

  it('redirects to /register if getMe rejects outright, rather than hanging on the loading state forever', async () => {
    mockedUseAuthStore.mockReturnValue({
      dbUser: null,
      session: { access_token: 'tok', expires_in: 3600 },
      setDbUser: vi.fn(),
    });
    mockedGetMe.mockRejectedValue(new Error('network error'));

    renderAt('/app/dashboard');

    await waitFor(() => expect(screen.getByText('Register Page')).toBeInTheDocument());
  });

  it('does not call getMe at all when there is no session (nothing to fetch with)', () => {
    mockedUseAuthStore.mockReturnValue({ dbUser: null, session: null, setDbUser: vi.fn() });

    renderAt('/app/dashboard');

    expect(mockedGetMe).not.toHaveBeenCalled();
    expect(screen.getByText('Register Page')).toBeInTheDocument();
  });
});
