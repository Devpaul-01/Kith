import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { workspaceService } from '@/services/workspace.service';
import { ledgerService } from '@/services/ledger.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { Card } from '@/components/ui/Card';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Badge } from '@/components/ui/Badge';
import { CurrencyAmount } from '@/components/ui/CurrencyAmount';
import { formatDate, timeAgo } from '@/utils/date';
import { useNavigate } from 'react-router-dom';
import { Users, AlertTriangle, Calendar } from 'lucide-react';
import type { DashboardData, LedgerEntry } from '@/types/models';
import showToast from '@/lib/toast';

export default function DashboardPage() {
  // 🔍 LOG 1: Component mount
  console.log('🔍 [DashboardPage] Component rendering');
  
  const { workspaceId, workspace } = useWorkspace();
  
  // 🔍 LOG 2: Check what useWorkspace returned
  console.log('🔍 [DashboardPage] useWorkspace result:', { 
    workspaceId, 
    workspaceIdType: typeof workspaceId,
    workspaceIdValue: workspaceId,
    workspaceExists: !!workspace,
    workspaceName: workspace?.name 
  });
  
  const isAdmin = useIsAdmin();
  const nav = useNavigate();
  const qc = useQueryClient();

  // 🔍 LOG 3: Before useQuery
  console.log('🔍 [DashboardPage] About to call useQuery with:', {
    workspaceId,
    enabled: !!workspaceId,
    queryKey: KEYS.dashboard(workspaceId)
  });

  const { data, isLoading, error } = useQuery<DashboardData>({
    queryKey: KEYS.dashboard(workspaceId),
    queryFn: async () => {
      // 🔍 LOG 4: Inside queryFn - this runs when enabled
      console.log('🔍 [DashboardPage] queryFn executing with workspaceId:', workspaceId);
      
      if (!workspaceId) {
        console.error('🔴 [DashboardPage] workspaceId is undefined in queryFn!');
        throw new Error('Workspace ID is required');
      }
      
      console.log('🔍 [DashboardPage] Calling workspaceService.getDashboard with:', workspaceId);
      const result = await workspaceService.getDashboard(workspaceId);
      console.log('🔍 [DashboardPage] workspaceService.getDashboard result:', result);
      return result;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    enabled: !!workspaceId, // Don't run if no workspaceId
    retry: 1,
  });
  const confirmMutation = useMutation({
    mutationFn: ({ cId, eId }: { cId: string; eId: string }) => {
      console.log('🔍 [DashboardPage] Confirming contribution:', { cId, eId, workspaceId });
      return ledgerService.confirm(workspaceId, cId, eId);
    },
    onSuccess: () => { 
      console.log('✅ [DashboardPage] Confirmation successful, invalidating dashboard');
      qc.invalidateQueries({ queryKey: KEYS.dashboard(workspaceId) }); 
      showToast.success('Contribution confirmed'); 
    },
    onError: (err) => {
      console.error('🔴 [DashboardPage] Confirmation failed:', err);
      showToast.error('Failed to confirm');
    },
  });


  // 🔍 LOG 5: After useQuery
  console.log('🔍 [DashboardPage] useQuery state:', { 
    workspaceId,
    isLoading, 
    hasData: !!data, 
    error: error?.message,
    errorDetails: error
  });

  if (isLoading) {
    console.log('🔍 [DashboardPage] Showing loading skeleton');
    return (
      <div className="p-4 sm:p-6 space-y-6">
        <div className="grid grid-cols-3 gap-4">
          {Array(3).fill(0).map((_, i) => <SkeletonCard key={i} />)}
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          {Array(4).fill(0).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      </div>
    );
  }
  
  if (error) {
    console.error('🔴 [DashboardPage] Error state:', error);
    return (
      <div className="p-4 text-center">
        <div className="bg-danger/10 rounded-lg p-6 max-w-md mx-auto">
          <AlertTriangle className="text-danger mx-auto mb-3" size={32} />
          <p className="text-danger font-semibold mb-2">Failed to load dashboard</p>
          <p className="text-sm text-text-secondary mb-4">
            {error.message || "Please try again later"}
          </p>
          <button 
            onClick={() => window.location.reload()} 
            className="px-4 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary/90"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
  
  if (!data) {
    console.warn('⚠️ [DashboardPage] No dashboard data received');
    return (
      <div className="p-4 text-center">
        <p className="text-text-secondary">No dashboard data available</p>
      </div>
    );
  }

  // Now safe to access data
  const d = data;

  // Check if workspace_summary exists
  if (!d.workspace_summary) {
    console.error("🔴 [DashboardPage] Missing workspace_summary in dashboard data", d);
    return (
      <div className="p-4 text-center">
        <p className="text-danger">Invalid dashboard data structure</p>
      </div>
    );
  }

  console.log('✅ [DashboardPage] Successfully rendering dashboard with data:', {
    memberCount: d.workspace_summary.member_count,
    activeEvents: d.active_events?.length,
    deadlines: d.upcoming_deadlines?.length
  });

  
  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">{workspace?.name || 'Dashboard'}</h1>
        <p className="text-sm text-text-secondary">Overview of your workspace</p>
      </div>

      <div className="grid grid-cols-3 gap-3 sm:gap-4">
        {[
          { label: 'Members', value: d.workspace_summary.member_count, Icon: Users, color: 'text-blue-500' },
          { label: 'Admins',  value: d.workspace_summary.admin_count,  Icon: Users, color: 'text-purple-500' },
          { label: 'Proxies', value: d.workspace_summary.proxy_count,  Icon: Users, color: 'text-orange-500' },
        ].map(item => (
          <Card key={item.label} padding="sm" className="text-center">
            <item.Icon className={`mx-auto mb-1 ${item.color}`} size={20} />
            <p className="text-2xl font-bold text-text-primary">{item.value}</p>
            <p className="text-xs text-text-secondary">{item.label}</p>
          </Card>
        ))}
      </div>

      {isAdmin && d.pending_confirmations?.length > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <AlertTriangle className="text-warning" size={18} />
            <h2 className="font-semibold text-text-primary">Pending Confirmations ({d.pending_confirmations.length})</h2>
          </div>
          <div className="space-y-3">
            {d.pending_confirmations.slice(0, 5).map((e: LedgerEntry) => (
              <div key={e.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                <div>
                  <p className="text-sm font-medium text-text-primary">{e.contributor_name}</p>
                  <p className="text-xs text-text-secondary"><CurrencyAmount amount={e.amount} currency={e.currency} /> · {timeAgo(e.created_at)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge status={e.status} />
                  <button 
                    onClick={() => confirmMutation.mutate({ cId: e.container_id, eId: e.id })} 
                    disabled={confirmMutation.isPending} 
                    className="text-xs text-primary font-semibold hover:underline disabled:opacity-50"
                  >
                    Confirm
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid sm:grid-cols-2 gap-4">
        {d.active_events?.length > 0 && (
          <Card>
            <div className="flex items-center gap-2 mb-4">
              <Calendar className="text-primary" size={18} />
              <h2 className="font-semibold text-text-primary">Active Events</h2>
            </div>
            <div className="space-y-4">
              {d.active_events.map(e => (
                <div key={e.id} className="cursor-pointer" onClick={() => nav(`/app/containers/${e.id}`)}>
                  <div className="flex justify-between items-start mb-1.5">
                    <p className="text-sm font-medium text-text-primary">{e.name}</p>
                    {e.days_until !== undefined && e.days_until !== null && (
                      <span className="text-xs text-text-secondary">{e.days_until > 0 ? `${e.days_until}d left` : 'Today'}</span>
                    )}
                  </div>
                  <ProgressBar value={e.progress_pct || 0} />
                  <p className="text-xs text-text-secondary mt-1">{e.progress_pct || 0}% funded</p>
                </div>
              ))}
            </div>
          </Card>
        )}

        {d.upcoming_deadlines?.length > 0 && (
          <Card>
            <h2 className="font-semibold text-text-primary mb-4">Upcoming Deadlines</h2>
            <div className="space-y-3">
              {d.upcoming_deadlines.slice(0, 5).map((dl, i) => (
                <div key={i} className="flex justify-between items-center py-2 border-b border-border last:border-0">
                  <div>
                    <p className="text-sm font-medium text-text-primary">{dl.member_name}</p>
                    <p className="text-xs text-text-secondary">{dl.container_name}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-semibold text-text-primary">{formatDate(dl.due_date, 'MMM d')}</p>
                    <p className={dl.days_until <= 3 ? 'text-xs text-danger font-semibold' : 'text-xs text-text-secondary'}>
                      {dl.days_until}d
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      {d.recent_activity?.length > 0 && (
        <Card>
          <h2 className="font-semibold text-text-primary mb-4">Recent Activity</h2>
          <div className="space-y-3">
            {d.recent_activity.map((a, idx) => (
              <div key={idx} className="flex gap-3 py-2 border-b border-border last:border-0">
                <div className="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0 text-xs font-bold text-text-secondary">
                  {a.actor_name?.[0]?.toUpperCase() ?? '?'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-text-primary line-clamp-1">{a.description}</p>
                  <p className="text-xs text-text-secondary mt-0.5">{timeAgo(a.created_at)}</p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}