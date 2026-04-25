// pages/settings/WorkspaceSettingsPage.tsx
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { workspaceService, type Workspace, type WorkspaceSettings } from '@/services/workspace.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useNavigate } from 'react-router-dom';
import { Tabs } from '@/components/ui/Tabs';
import { Card } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';
import { GeneralSettingsTab } from '@/components/workspace/GeneralSettingsTab';
import { AppearanceTab } from '@/components/workspace/AppearanceTab';
import { PreferencesTab } from '@/components/workspace/PreferencesTab';
import { DangerZoneTab } from '@/components/workspace/DangerZoneTab';
import showToast from '@/lib/toast';

export default function WorkspaceSettingsPage() {
  const { workspaceId, workspace } = useWorkspace();
  const { clear: clearWs } = useWorkspaceStore();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [activeTab, setActiveTab] = useState('general');

  // Fetch workspace details (refresh after updates)
  const { data: workspaceData, isLoading: workspaceLoading, refetch: refetchWorkspace } = useQuery({
    queryKey: KEYS.workspace(workspaceId),
    queryFn: () => workspaceService.get(workspaceId),
  });

  // Fetch workspace settings
  const { data: settingsData, isLoading: settingsLoading, refetch: refetchSettings } = useQuery({
    queryKey: KEYS.settings(workspaceId),
    queryFn: () => workspaceService.getSettings(workspaceId),
  });

  const currentWorkspace = workspaceData?.workspace || workspace;
  const settings = settingsData?.settings;

  const updateWorkspaceMutation = useMutation({
    mutationFn: (payload: Parameters<typeof workspaceService.update>[1]) =>
      workspaceService.update(workspaceId, payload),
    onSuccess: (data) => {
      // Invalidate both the workspace and the specific workspace query
      qc.invalidateQueries({ queryKey: KEYS.workspace(workspaceId) });
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      refetchWorkspace();
      showToast.success('Workspace settings saved successfully');
    },
    onError: (error: any) => {
      const message = error?.response?.data?.error?.message || 'Failed to save settings';
      showToast.error(message);
    },
  });

  const updateSettingsMutation = useMutation({
    mutationFn: (payload: Partial<WorkspaceSettings>) =>
      workspaceService.updateSettings(workspaceId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.settings(workspaceId) });
      refetchSettings();
      showToast.success('Preferences saved successfully');
    },
    onError: (error: any) => {
      const message = error?.response?.data?.error?.message || 'Failed to save preferences';
      showToast.error(message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => workspaceService.delete(workspaceId),
    onSuccess: () => {
      clearWs();
      qc.removeQueries({ queryKey: KEYS.workspace(workspaceId) });
      showToast.success('Workspace deleted successfully');
      nav('/workspace/select');
    },
    onError: (error: any) => {
      const message = error?.response?.data?.error?.message || 'Failed to delete workspace';
      showToast.error(message);
    },
  });

  if (workspaceLoading || settingsLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!currentWorkspace) {
    return (
      <div className="p-6 text-center text-text-secondary">
        Workspace not found.
      </div>
    );
  }

  const tabs = [
    { id: 'general', label: 'General' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'preferences', label: 'Preferences' },
    { id: 'danger', label: 'Danger Zone' },
  ];

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold text-text-primary">Workspace Settings</h1>
        <p className="text-sm text-text-secondary mt-0.5">
          Manage your workspace configuration and preferences
        </p>
      </div>

      <Tabs
        tabs={tabs}
        activeTab={activeTab}
        onChange={setActiveTab}
      />

      {activeTab === 'general' && (
        <GeneralSettingsTab
          workspace={currentWorkspace}
          onUpdate={(payload) => updateWorkspaceMutation.mutate(payload)}
          isUpdating={updateWorkspaceMutation.isPending}
        />
      )}

      {activeTab === 'appearance' && (
        <AppearanceTab
          workspace={currentWorkspace}
          onUpdate={(payload) => updateWorkspaceMutation.mutate(payload)}
          isUpdating={updateWorkspaceMutation.isPending}
        />
      )}

      {activeTab === 'preferences' && (
        <PreferencesTab
          settings={settings || {}}
          onUpdate={(payload) => updateSettingsMutation.mutate(payload)}
          isUpdating={updateSettingsMutation.isPending}
        />
      )}

      {activeTab === 'danger' && (
        <DangerZoneTab
          workspaceId={workspaceId}
          workspaceName={currentWorkspace.name}
          onDelete={deleteMutation.mutate}
          isDeleting={deleteMutation.isPending}
        />
      )}
    </div>
  );
}