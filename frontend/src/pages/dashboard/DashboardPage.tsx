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
import { Users, AlertTriangle, Calendar, RefreshCcw, ListChecks, Scale, UserX, Sparkles } from 'lucide-react';
import type { DashboardData, LedgerEntry } from '@/types/models';
import showToast from '@/lib/toast';

// ── Overdue summary types (matches dashboard_service.js#getOverdueSummaryData) ──
interface OverdueContainerEntry {
  container_id: string;
  container_name: string;
  outstanding: number;
  currency: string;
  due_date: string;
}
interface OverdueMemberEntry {
  member_id: string;
  display_name: string | null;
  total_outstanding: number;
  containers: OverdueContainerEntry[];
}
interface OverdueSummary {
  overdue_count: number;
  overdue: OverdueMemberEntry[];
}

export default function DashboardPage() {
  const { workspaceId, workspace } = useWorkspace();
  const isAdmin = useIsAdmin();
  const nav = useNavigate();
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery<DashboardData>({
    queryKey: KEYS.dashboard(workspaceId),
    queryFn: async () => {
      if (!workspaceId) {
        throw new Error('Workspace ID is required');
      }
      return workspaceService.getDashboard(workspaceId);
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    enabled: !!workspaceId,
    retry: 1,
  });

  // Admin-only: overdue contributions across the workspace. Kept as a
  // separate query (rather than folded into the main dashboard payload)
  // since it's already its own endpoint and non-admins never need it.
  const { data: overdueData } = useQuery<{ data: OverdueSummary }>({
    queryKey: KEYS.overdueSummary(workspaceId),
    queryFn: () => workspaceService.getOverdueSummary(workspaceId),
    staleTime: 60_000,
    enabled: !!workspaceId && isAdmin,
    retry: 1,
  });
  const overdue = overdueData?.data;

  const confirmMutation = useMutation({
    mutationFn: ({ cId, eId }: { cId: string; eId: string }) => {
      return ledgerService.confirm(workspaceId, cId, eId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.dashboard(workspaceId) });
      showToast.success('Contribution confirmed');
    },
    onError: () => {
      showToast.error('Failed to confirm');
    },
  });

  if (isLoading) {
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
    return (
      <div className="p-4 text-center">
        <p className="text-text-secondary">No dashboard data available</p>
      </div>
    );
  }

  const d = data;

  if (!d.workspace_summary) {
    return (
      <div className="p-4 text-center">
        <p className="text-danger">Invalid dashboard data structure</p>
      </div>
    );
  }

  const myTasks = d.my_tasks_summary;
  const engagement = d.engagement_summary;
  const recentMilestones = d.recent_milestones || [];

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

      {/* ── Admin attention row: overdue + disputes + engagement ── */}
      {isAdmin && (
        <div className="grid sm:grid-cols-3 gap-4">
          {overdue && overdue.overdue_count > 0 && (
            <Card
              className="cursor-pointer hover:border-danger/40"
              onClick={() => nav('/app/members/engagement')}
            >
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="text-danger" size={18} />
                <h2 className="font-semibold text-text-primary text-sm">Overdue Contributions</h2>
              </div>
              <p className="text-2xl font-bold text-danger">{overdue.overdue_count}</p>
              <p className="text-xs text-text-secondary mb-2">member{overdue.overdue_count === 1 ? '' : 's'} behind</p>
              <div className="space-y-1">
                {overdue.overdue.slice(0, 3).map((m) => (
                  <div key={m.member_id} className="flex justify-between text-xs">
                    <span className="text-text-primary truncate">{m.display_name}</span>
                    <span className="text-danger font-medium">
                      <CurrencyAmount amount={m.total_outstanding} currency={m.containers[0]?.currency || ''} />
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {d.open_disputes_count !== null && d.open_disputes_count !== undefined && d.open_disputes_count > 0 && (
            <Card
              className="cursor-pointer hover:border-warning/40"
              onClick={() => nav('/app/disputes')}
            >
              <div className="flex items-center gap-2 mb-2">
                <Scale className="text-warning" size={18} />
                <h2 className="font-semibold text-text-primary text-sm">Open Disputes</h2>
              </div>
              <p className="text-2xl font-bold text-warning">{d.open_disputes_count}</p>
              <p className="text-xs text-text-secondary">awaiting resolution</p>
            </Card>
          )}

          {engagement && (engagement.quiet_count > 0 || engagement.inactive_count > 0) && (
            <Card
              className="cursor-pointer hover:border-orange-400/40"
              onClick={() => nav('/app/members/engagement')}
            >
              <div className="flex items-center gap-2 mb-2">
                <UserX className="text-orange-500" size={18} />
                <h2 className="font-semibold text-text-primary text-sm">Member Engagement</h2>
              </div>
              <p className="text-2xl font-bold text-orange-500">{engagement.inactive_count}</p>
              <p className="text-xs text-text-secondary mb-2">inactive · {engagement.quiet_count} quiet</p>
              {engagement.inactive_members.length > 0 && (
                <p className="text-xs text-text-secondary truncate">
                  {engagement.inactive_members.map((m) => m.display_name).join(', ')}
                </p>
              )}
            </Card>
          )}
        </div>
      )}

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

      {/* ── Recurring pools ── */}
      {d.recurring_pools?.length > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <RefreshCcw className="text-primary" size={18} />
            <h2 className="font-semibold text-text-primary">Recurring Pools</h2>
          </div>
          <div className="space-y-3">
            {d.recurring_pools.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between py-2 border-b border-border last:border-0 cursor-pointer"
                onClick={() => nav(`/app/containers/${p.id}`)}
              >
                <div>
                  <p className="text-sm font-medium text-text-primary">{p.name}</p>
                  {p.current_cycle ? (
                    <p className="text-xs text-text-secondary">
                      Cycle {formatDate(p.current_cycle.cycle_start, 'MMM d')} – {formatDate(p.current_cycle.cycle_end, 'MMM d')}
                    </p>
                  ) : (
                    <p className="text-xs text-text-secondary">No active cycle</p>
                  )}
                </div>
                {p.current_cycle && (
                  <Badge status={p.current_cycle.status} />
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── My tasks ── */}
      {myTasks && (myTasks.pending_count > 0 || myTasks.in_progress_count > 0 || myTasks.overdue_count > 0) && (
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <ListChecks className="text-primary" size={18} />
            <h2 className="font-semibold text-text-primary">My Tasks</h2>
          </div>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div className="text-center">
              <p className="text-xl font-bold text-text-primary">{myTasks.pending_count}</p>
              <p className="text-xs text-text-secondary">Pending</p>
            </div>
            <div className="text-center">
              <p className="text-xl font-bold text-text-primary">{myTasks.in_progress_count}</p>
              <p className="text-xs text-text-secondary">In progress</p>
            </div>
            <div className="text-center">
              <p className="text-xl font-bold text-danger">{myTasks.overdue_count}</p>
              <p className="text-xs text-text-secondary">Overdue</p>
            </div>
          </div>
          {myTasks.next_due && (
            <div
              className="flex justify-between items-center pt-2 border-t border-border cursor-pointer"
              onClick={() => nav(`/app/containers/${myTasks.next_due!.container_id}/tasks`)}
            >
              <div>
                <p className="text-sm font-medium text-text-primary">{myTasks.next_due.title}</p>
                <p className="text-xs text-text-secondary">{myTasks.next_due.container_name}</p>
              </div>
              <p className="text-xs text-text-secondary">{formatDate(myTasks.next_due.due_date, 'MMM d')}</p>
            </div>
          )}
        </Card>
      )}

      {/* ── Recent milestones ── */}
      {recentMilestones.length > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <Sparkles className="text-primary" size={18} />
            <h2 className="font-semibold text-text-primary">Recent Milestones</h2>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {recentMilestones.map((m) => (
              <div
                key={m.id}
                className="flex-shrink-0 w-40 cursor-pointer"
                onClick={() => nav('/app/timeline')}
              >
                {m.cover_photo ? (
                  <img
                    src={m.cover_photo.url}
                    alt={m.title}
                    className="w-40 h-28 object-cover rounded-lg mb-1.5"
                  />
                ) : (
                  <div className="w-40 h-28 rounded-lg bg-slate-100 flex items-center justify-center mb-1.5">
                    <Sparkles className="text-text-secondary" size={20} />
                  </div>
                )}
                <p className="text-sm font-medium text-text-primary line-clamp-1">{m.title}</p>
                <p className="text-xs text-text-secondary">{formatDate(m.milestone_date, 'MMM d, yyyy')}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

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