import{useUIStore}from'@/store/uiStore';import{useNotifications,useMarkAllRead}from'@/hooks/useNotifications';import{NotificationItem}from'./NotificationItem';import{X,CheckCheck}from'lucide-react';import{Spinner}from'@/components/ui/Spinner';import{Button}from'@/components/ui/Button';import type{Notification}from'@/types/models';import{cn}from'@/utils/cn';
export function NotificationDrawer(){
  const{notificationDrawerOpen,setNotificationDrawerOpen}=useUIStore();
  const{data,isLoading,fetchNextPage,hasNextPage,isFetchingNextPage}=useNotifications();
  const markAll=useMarkAllRead();
  const pages=data?.pages as Array<{notifications?:Notification[]}>|undefined;
  const notifications:Notification[]=pages?.flatMap(p=>p.notifications??[])??[];
  return(<>
    {notificationDrawerOpen&&<div className="fixed inset-0 bg-black/20 z-40" onClick={()=>setNotificationDrawerOpen(false)}/>}
    <div className={cn('fixed top-0 right-0 h-full w-full max-w-sm bg-white border-l border-border z-50 flex flex-col shadow-2xl transition-transform duration-300',notificationDrawerOpen?'translate-x-0':'translate-x-full')}>
      <div className="flex items-center justify-between px-4 py-4 border-b border-border flex-shrink-0"><h2 className="font-bold text-text-primary">Notifications</h2><div className="flex items-center gap-2">{notifications.some(n=>!n.is_read)&&<Button variant="ghost" size="sm" onClick={()=>markAll.mutate()} loading={markAll.isPending}><CheckCheck size={14}/>Mark all read</Button>}<button onClick={()=>setNotificationDrawerOpen(false)} className="p-1.5 rounded-lg hover:bg-slate-100"><X size={18}/></button></div></div>
      <div className="flex-1 overflow-y-auto">{isLoading&&<div className="flex justify-center py-12"><Spinner/></div>}{!isLoading&&notifications.length===0&&<p className="text-center text-sm text-text-secondary py-12">You're all caught up 🎉</p>}{notifications.map(n=><NotificationItem key={n.id} notification={n} onClose={()=>setNotificationDrawerOpen(false)}/>)}{hasNextPage&&<div className="p-4 text-center"><Button variant="ghost" size="sm" loading={isFetchingNextPage} onClick={()=>fetchNextPage()}>Load more</Button></div>}</div>
    </div>
  </>);
}
