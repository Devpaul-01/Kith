import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { milestoneService, type TimelineItem } from '@/services/milestone.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { MilestoneCard } from '@/components/milestones/MilestoneCard';
import { ContainerCompletedCard } from '@/components/milestones/ContainerCompletedCard';
import { CreateMilestoneModal } from '@/components/milestones/CreateMilestoneModal';
import { Tabs } from '@/components/ui/Tabs';
import { Clock, Calendar, CheckCircle } from 'lucide-react';

type FilterType = 'all' | 'milestones' | 'completed';

export default function TimelinePage() {
  const { workspaceId } = useWorkspace();
  const isAdmin = useIsAdmin();
  const [showCreate, setShowCreate] = useState(false);
  const [filter, setFilter] = useState<FilterType>('all');

  const { data, isLoading, refetch } = useQuery({
    queryKey: KEYS.timeline(workspaceId),
    queryFn: () => milestoneService.getTimeline(workspaceId),
    staleTime: 300_000,
  });

  const items: TimelineItem[] = (data as { items?: TimelineItem[] })?.items ?? [];

  const filteredItems = items.filter(item => {
    if (filter === 'milestones') return item.type === 'milestone';
    if (filter === 'completed') return item.type === 'container_completed';
    return true;
  });

  const tabs = [
    { id: 'all', label: 'All Events' },
    { id: 'milestones', label: 'Milestones' },
    { id: 'completed', label: 'Completed Events' },
  ];

  const stats = {
    total: items.length,
    milestones: items.filter(i => i.type === 'milestone').length,
    completed: items.filter(i => i.type === 'container_completed').length,
  };

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Timeline</h1>
          <div className="flex items-center gap-3 mt-1 text-xs text-text-secondary">
            <span className="flex items-center gap-1">
              <Calendar size={12} /> {stats.total} total events
            </span>
            <span className="flex items-center gap-1">
              <Clock size={12} /> {stats.milestones} milestones
            </span>
            <span className="flex items-center gap-1">
              <CheckCircle size={12} /> {stats.completed} completed
            </span>
          </div>
        </div>
        {isAdmin && (
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Clock size={14} /> Add Milestone
          </Button>
        )}
      </div>

      {/* Tabs */}
      <Tabs tabs={tabs} activeTab={filter} onChange={(id) => setFilter(id as FilterType)} />

      {/* Loading */}
      {isLoading && (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      )}

      {/* Empty State */}
      {!isLoading && filteredItems.length === 0 && (
        <EmptyState
          icon={<Clock size={36} />}
          title={filter === 'all' ? 'No timeline events yet' : filter === 'milestones' ? 'No milestones yet' : 'No completed events yet'}
          description={
            filter === 'all'
              ? 'Complete containers or add milestones to build your family timeline.'
              : filter === 'milestones'
              ? 'Click "Add Milestone" to document important family moments.'
              : 'Complete containers to see them appear here.'
          }
          action={
            isAdmin && filter === 'milestones' ? (
              <Button size="sm" onClick={() => setShowCreate(true)}>
                <Clock size={14} /> Add Milestone
              </Button>
            ) : undefined
          }
        />
      )}

      {/* Timeline List */}
      {!isLoading && filteredItems.length > 0 && (
        <div className="relative">
          <div className="absolute left-5 top-0 bottom-0 w-0.5 bg-border" />
          <div className="space-y-6">
            {filteredItems.map((item, idx) => (
              item.type === 'milestone' ? (
                <MilestoneCard
                  key={`${item.reference_type}-${item.reference_id}-${idx}`}
                  milestone={{
                    id: item.reference_id,
                    workspace_id: workspaceId,
                    title: item.title,
                    description: item.description || undefined,
                    milestone_date: item.date.split('T')[0],
                    photos: item.photos || [],
                    created_at: item.date,
                    updated_at: item.date,
                  }}
                  workspaceId={workspaceId}
                  isAdmin={isAdmin}
                  onUpdate={() => refetch()}
                />
              ) : (
                <ContainerCompletedCard key={`${item.reference_type}-${item.reference_id}-${idx}`} item={item} />
              )
            ))}
          </div>
        </div>
      )}

      {/* Create Milestone Modal */}
      <CreateMilestoneModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        workspaceId={workspaceId}
      />
    </div>
  );
}