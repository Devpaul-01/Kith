// router/WorkspaceGuard.test.tsx
//
// Gates every /app/workspace/:id/* route behind having an active
// workspace selected, and (as a side effect) refreshes the cached
// workspace/member data on mount. Previously untested, and the one
// guard in this app with an async side effect — the thing most likely
// to be silently broken by a refactor without a test catching it.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { WorkspaceGuard } from './WorkspaceGuard';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { workspaceService } from '@/services/workspace.service';

vi.mock('@/store/workspaceStore', () => ({
  useWorkspaceStore: vi.fn(),
}));

vi.mock('@/services/workspace.service', () => ({
  workspaceService: { get: vi.fn() },
}));

const mockedUseWorkspaceStore = vi.mocked(useWorkspaceStore);
const mockedGet = vi.mocked(workspaceService.get);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<WorkspaceGuard />}>
          <Route path="/app/workspace/:id" element={<div>Workspace Content</div>} />
        </Route>
        <Route path="/workspace/select" element={<div>Select Workspace Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('WorkspaceGuard', () => {
  beforeEach(() => {
    mockedUseWorkspaceStore.mockReset();
    mockedGet.mockReset();
  });

  it('redirects to /workspace/select when no workspace is active', () => {
    mockedUseWorkspaceStore.mockReturnValue({ activeWorkspaceId: null, setWorkspace: vi.fn() });

    renderAt('/app/workspace/ws-1');

    expect(screen.getByText('Select Workspace Page')).toBeInTheDocument();
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('renders the workspace content immediately (not blocked on the background refresh) when a workspace is already active', () => {
    mockedUseWorkspaceStore.mockReturnValue({ activeWorkspaceId: 'ws-1', setWorkspace: vi.fn() });
    mockedGet.mockReturnValue(new Promise(() => {})); // never resolves in this test — proves render isn't gated on it

    renderAt('/app/workspace/ws-1');

    expect(screen.getByText('Workspace Content')).toBeInTheDocument();
  });

  it('fetches the latest workspace/member data for the active workspace on mount', async () => {
    mockedUseWorkspaceStore.mockReturnValue({ activeWorkspaceId: 'ws-1', setWorkspace: vi.fn() });
    mockedGet.mockResolvedValue({ workspace: { id: 'ws-1' }, current_member: { id: 'm-1' } });

    renderAt('/app/workspace/ws-1');

    await waitFor(() => expect(mockedGet).toHaveBeenCalledWith('ws-1'));
  });

  it('calls setWorkspace with the refreshed data once the fetch resolves', async () => {
    const setWorkspace = vi.fn();
    mockedUseWorkspaceStore.mockReturnValue({ activeWorkspaceId: 'ws-1', setWorkspace });
    const workspace = { id: 'ws-1', name: 'Updated Name' };
    const current_member = { id: 'm-1', role: 'admin' };
    mockedGet.mockResolvedValue({ workspace, current_member });

    renderAt('/app/workspace/ws-1');

    await waitFor(() => expect(setWorkspace).toHaveBeenCalledWith(workspace, current_member));
  });

  it('does not throw or redirect if the background refresh fails — stays on the already-rendered content', async () => {
    const setWorkspace = vi.fn();
    mockedUseWorkspaceStore.mockReturnValue({ activeWorkspaceId: 'ws-1', setWorkspace });
    mockedGet.mockRejectedValue(new Error('network error'));

    renderAt('/app/workspace/ws-1');

    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    expect(screen.getByText('Workspace Content')).toBeInTheDocument();
    expect(setWorkspace).not.toHaveBeenCalled();
  });
});
