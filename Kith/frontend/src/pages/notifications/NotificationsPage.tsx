import { useNotifications, useMarkAllRead } from '@/hooks/useNotifications';
import { NotificationItem } from '@/components/notifications/NotificationItem';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { Bell, CheckCheck } from 'lucide-react';
import { useUIStore } from '@/store/uiStore';
import type { Notification } from '@/types/models';

export default function NotificationsPage() {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useNotifications();
  const markAll = useMarkAllRead();
  const { setNotificationDrawerOpen } = useUIStore();
  const pages = data?.pages as Array<{ notifications?: Notification[] }> | undefined;
  const notifications: Notification[] = pages?.flatMap(p => p.notifications ?? []) ?? [];
  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-text-primary">Notifications</h1>
        {notifications.some(n => !n.is_read) && <Button variant="ghost" size="sm" onClick={() => markAll.mutate()} loading={markAll.isPending}><CheckCheck size={14} />Mark all read</Button>}
      </div>
      {isLoading && <div className="flex justify-center py-8"><Spinner /></div>}
      {!isLoading && notifications.length === 0 && <EmptyState icon={<Bell size={36} />} title="You're all caught up" description="No new notifications." />}
      <div className="bg-white border border-border rounded-2xl overflow-hidden">
        {notifications.map(n => <NotificationItem key={n.id} notification={n} onClose={() => setNotificationDrawerOpen(false)} />)}
      </div>
      {hasNextPage && <div className="text-center"><Button variant="ghost" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>Load more</Button></div>}
    </div>
  );
}
