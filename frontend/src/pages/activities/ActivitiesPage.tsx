// pages/activities/ActivitiesPage.tsx
import { useState } from 'react';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { Card } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { formatDate, timeAgo } from '@/utils/date';
import { 
  Filter, 
  ChevronLeft, 
  ChevronRight, 
  Download,
  Calendar,
  User,
  Tag
} from 'lucide-react';
import showToast from '@/lib/toast';

interface AuditEntry {
  id: string;
  action: string;
  actor_name: string;
  target_type: string;
  target_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface AuditLogResponse {
  entries: AuditEntry[];
  meta: {
    pagination: {
      page: number;
      per_page: number;
      total: number;
    };
  };
}

const ACTION_OPTIONS = [
  { value: '', label: 'All Actions' },
  { value: 'container.completed', label: 'Container Completed' },
  { value: 'container.archived', label: 'Container Archived' },
  { value: 'container.deleted', label: 'Container Deleted' },
  { value: 'container.settings_changed', label: 'Container Settings Changed' },
  { value: 'container.participants_added', label: 'Participants Added' },
  { value: 'container.converted_to_recurring', label: 'Converted to Recurring' },
  { value: 'ledger.confirmed', label: 'Contribution Confirmed' },
  { value: 'ledger.submitted', label: 'Contribution Submitted' },
  { value: 'ledger.corrected', label: 'Correction Added' },
  { value: 'dispute.raised', label: 'Dispute Raised' },
  { value: 'dispute.resolved', label: 'Dispute Resolved' },
  { value: 'workspace.settings_changed', label: 'Workspace Settings Changed' },
  { value: 'workspace.deleted', label: 'Workspace Deleted' },
  { value: 'member.removed', label: 'Member Removed' },
  { value: 'cycle.override_applied', label: 'Cycle Override Applied' },
  { value: 'task.created', label: 'Task Created' },
  { value: 'task.completed', label: 'Task Completed' },
  { value: 'task.confirmed', label: 'Task Confirmed' },
];

const ACTION_ICONS: Record<string, string> = {
  'container.completed': '✅',
  'container.archived': '📦',
  'container.deleted': '🗑️',
  'container.settings_changed': '⚙️',
  'container.participants_added': '👥',
  'container.converted_to_recurring': '🔄',
  'ledger.confirmed': '✓',
  'ledger.submitted': '📝',
  'ledger.corrected': '✏️',
  'dispute.raised': '⚠️',
  'dispute.resolved': '✅',
  'workspace.settings_changed': '⚙️',
  'workspace.deleted': '🗑️',
  'member.removed': '🚫',
  'cycle.override_applied': '🔄',
  'task.created': '📋',
  'task.completed': '✓',
  'task.confirmed': '✅',
};

function getActionDisplay(action: string): string {
  const found = ACTION_OPTIONS.find(o => o.value === action);
  return found ? found.label : action.replace(/\./g, ' ');
}

// ── Mock data: Adeyemi Family workspace ──────────────────────────────────────

const MOCK_MEMBERS = [
  { id: 'mem_folake', display_name: 'Folake Adeyemi' },
  { id: 'mem_tunde', display_name: 'Tunde Adeyemi' },
  { id: 'mem_bisi', display_name: 'Bisi Adeyemi' },
  { id: 'mem_kunle', display_name: 'Kunle Adeyemi' },
  { id: 'mem_ngozi', display_name: 'Ngozi Adeyemi' },
];

const MOCK_ENTRIES: AuditEntry[] = [
  {
    id: 'evt_001',
    action: 'ledger.confirmed',
    actor_name: 'Folake Adeyemi',
    target_type: 'ledger_entry',
    target_id: 'ldg_2201',
    metadata: { amount: 25000, currency: 'NGN', container: 'August Rent Pool' },
    created_at: '2026-08-22T09:14:00Z',
  },
  {
    id: 'evt_002',
    action: 'task.completed',
    actor_name: 'Kunle Adeyemi',
    target_type: 'task',
    target_id: 'tsk_1187',
    metadata: { title: 'Pick up grandma\'s medication' },
    created_at: '2026-08-21T18:42:00Z',
  },
  {
    id: 'evt_003',
    action: 'ledger.submitted',
    actor_name: 'Tunde Adeyemi',
    target_type: 'ledger_entry',
    target_id: 'ldg_2198',
    metadata: { amount: 15000, currency: 'NGN', method: 'bank_transfer' },
    created_at: '2026-08-21T11:05:00Z',
  },
  {
    id: 'evt_004',
    action: 'container.participants_added',
    actor_name: 'Folake Adeyemi',
    target_type: 'container',
    target_id: 'cnt_0044',
    metadata: { added: ['Ngozi Adeyemi'], container: 'Christmas Trip Fund' },
    created_at: '2026-08-20T16:30:00Z',
  },
  {
    id: 'evt_005',
    action: 'dispute.raised',
    actor_name: 'Bisi Adeyemi',
    target_type: 'ledger_entry',
    target_id: 'ldg_2180',
    metadata: { reason: 'Amount recorded does not match receipt' },
    created_at: '2026-08-19T20:10:00Z',
  },
  {
    id: 'evt_006',
    action: 'dispute.resolved',
    actor_name: 'Folake Adeyemi',
    target_type: 'ledger_entry',
    target_id: 'ldg_2180',
    metadata: { resolution: 'Corrected amount to ₦18,500 after receipt review' },
    created_at: '2026-08-20T08:00:00Z',
  },
  {
    id: 'evt_007',
    action: 'task.created',
    actor_name: 'Folake Adeyemi',
    target_type: 'task',
    target_id: 'tsk_1190',
    metadata: { title: 'Book caterer for Segun\'s birthday', assigned_to: 'Bisi Adeyemi' },
    created_at: '2026-08-18T14:22:00Z',
  },
  {
    id: 'evt_008',
    action: 'container.converted_to_recurring',
    actor_name: 'Folake Adeyemi',
    target_type: 'container',
    target_id: 'cnt_0039',
    metadata: { container: 'Monthly Rent Pool', cadence: 'monthly' },
    created_at: '2026-08-17T09:00:00Z',
  },
  {
    id: 'evt_009',
    action: 'task.confirmed',
    actor_name: 'Folake Adeyemi',
    target_type: 'task',
    target_id: 'tsk_1175',
    metadata: { title: 'Renew family WAEC prep subscription' },
    created_at: '2026-08-16T13:47:00Z',
  },
  {
    id: 'evt_010',
    action: 'cycle.override_applied',
    actor_name: 'Folake Adeyemi',
    target_type: 'cycle',
    target_id: 'cyc_0512',
    metadata: { member: 'Kunle Adeyemi', reason: 'Waived due to travel', amount_waived: 15000 },
    created_at: '2026-08-15T10:12:00Z',
  },
  {
    id: 'evt_011',
    action: 'ledger.corrected',
    actor_name: 'Tunde Adeyemi',
    target_type: 'ledger_entry',
    target_id: 'ldg_2140',
    metadata: { old_amount: 10000, new_amount: 12000 },
    created_at: '2026-08-14T19:03:00Z',
  },
  {
    id: 'evt_012',
    action: 'member.removed',
    actor_name: 'Folake Adeyemi',
    target_type: 'member',
    target_id: 'mem_yemi',
    metadata: { removed_member: 'Yemi Adeyemi', reason: 'Left household' },
    created_at: '2026-08-10T07:55:00Z',
  },
  {
    id: 'evt_013',
    action: 'container.completed',
    actor_name: 'Folake Adeyemi',
    target_type: 'container',
    target_id: 'cnt_0031',
    metadata: { container: 'July Rent Pool', total_collected: 90000 },
    created_at: '2026-08-01T09:00:00Z',
  },
  {
    id: 'evt_014',
    action: 'workspace.settings_changed',
    actor_name: 'Folake Adeyemi',
    target_type: 'workspace',
    target_id: 'ws_adeyemi',
    metadata: { field: 'default_currency', old_value: 'USD', new_value: 'NGN' },
    created_at: '2026-07-28T12:15:00Z',
  },
  {
    id: 'evt_015',
    action: 'container.archived',
    actor_name: 'Folake Adeyemi',
    target_type: 'container',
    target_id: 'cnt_0022',
    metadata: { container: 'June School Supplies' },
    created_at: '2026-07-15T08:30:00Z',
  },
];

export default function ActivitiesPage() {
  const { workspaceId } = useWorkspace();
  const isAdmin = useIsAdmin();
  const [page, setPage] = useState(1);
  const [filterAction, setFilterAction] = useState('');
  const [filterActor, setFilterActor] = useState('');
  const [filterFromDate, setFilterFromDate] = useState('');
  const [filterToDate, setFilterToDate] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const perPage = 20;

  // MOCK: static audit log data for the Adeyemi Family workspace
  const isLoading = false;
  const members = MOCK_MEMBERS;

  const filteredEntries = MOCK_ENTRIES.filter((entry) => {
    if (filterAction && entry.action !== filterAction) return false;
    if (filterActor) {
      const actorMember = members.find(m => m.display_name === entry.actor_name);
      if (!actorMember || actorMember.id !== filterActor) return false;
    }
    if (filterFromDate && entry.created_at < filterFromDate) return false;
    if (filterToDate && entry.created_at > `${filterToDate}T23:59:59Z`) return false;
    return true;
  });

  const entries = filteredEntries;
  const total = filteredEntries.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));

  const handleExport = async () => {
    // MOCK: export disabled in static demo mode
    showToast.success('Export started');
  };

  const handleResetFilters = () => {
    setFilterAction('');
    setFilterActor('');
    setFilterFromDate('');
    setFilterToDate('');
    setPage(1);
  };

  if (!isAdmin) {
    return (
      <div className="p-6 text-center text-text-secondary">
        Only admins can view activity logs.
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Activities</h1>
          <p className="text-sm text-text-secondary mt-0.5">
            Complete audit log of all actions in this workspace
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setShowFilters(!showFilters)}
          >
            <Filter size={14} className="mr-1" /> Filters
          </Button>
          <Button size="sm" variant="secondary" onClick={handleExport}>
            <Download size={14} className="mr-1" /> Export
          </Button>
        </div>
      </div>

      {/* Filters */}
      {showFilters && (
        <Card className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Select
              label="Action"
              options={ACTION_OPTIONS}
              value={filterAction}
              onChange={(e) => setFilterAction(e.target.value)}
            />
            <Select
              label="Actor"
              options={[
                { value: '', label: 'All Actors' },
                ...members.map((m: any) => ({ value: m.id, label: m.display_name })),
              ]}
              value={filterActor}
              onChange={(e) => setFilterActor(e.target.value)}
            />
            <Input
              label="From Date"
              type="date"
              value={filterFromDate}
              onChange={(e) => setFilterFromDate(e.target.value)}
            />
            <Input
              label="To Date"
              type="date"
              value={filterToDate}
              onChange={(e) => setFilterToDate(e.target.value)}
            />
          </div>
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={handleResetFilters}>
              Reset Filters
            </Button>
          </div>
        </Card>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      )}

      {/* Empty State */}
      {!isLoading && entries.length === 0 && (
        <div className="text-center py-16 text-text-secondary border border-dashed border-border rounded-lg">
          <p className="text-lg mb-2">No activities found</p>
          <p className="text-sm">Try adjusting your filters or check back later.</p>
        </div>
      )}

      {/* Activity List */}
      {!isLoading && entries.length > 0 && (
        <div className="space-y-3">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="bg-white border border-border rounded-xl p-4 hover:shadow-sm transition-shadow"
            >
              <div className="flex items-start gap-3">
                <div className="text-2xl">
                  {ACTION_ICONS[entry.action] || '📌'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <p className="font-medium text-text-primary">
                      {getActionDisplay(entry.action)}
                    </p>
                    <span className="text-xs text-text-secondary">
                      {timeAgo(entry.created_at)}
                    </span>
                  </div>
                  <p className="text-sm text-text-secondary mt-1">
                    by <span className="font-medium text-text-primary">{entry.actor_name}</span>
                  </p>
                  {entry.metadata && Object.keys(entry.metadata).length > 0 && (
                    <div className="mt-2 text-xs text-text-secondary bg-surface-alt rounded-lg p-2">
                      <details>
                        <summary className="cursor-pointer">Details</summary>
                        <pre className="mt-2 text-xs overflow-x-auto">
                          {JSON.stringify(entry.metadata, null, 2)}
                        </pre>
                      </details>
                    </div>
                  )}
                  <p className="text-xs text-text-secondary mt-2">
                    {formatDate(entry.created_at)}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-4">
          <p className="text-sm text-text-secondary">
            Showing {((page - 1) * perPage) + 1} to {Math.min(page * perPage, total)} of {total} entries
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              <ChevronLeft size={14} /> Previous
            </Button>
            <span className="text-sm text-text-secondary px-2">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
            >
              Next <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
