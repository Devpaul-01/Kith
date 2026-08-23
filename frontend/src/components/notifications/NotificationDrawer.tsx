import{useState}from'react';import{useUIStore}from'@/store/uiStore';import{NotificationItem}from'./NotificationItem';import{X,CheckCheck}from'lucide-react';import{Spinner}from'@/components/ui/Spinner';import{Button}from'@/components/ui/Button';import type{Notification}from'@/types/models';import{cn}from'@/utils/cn';
// MOCK: static notification data for the Adeyemi Family workspace
const MOCK_NOTIFICATIONS:Notification[]=[
  {id:'ntf_001',type:'ledger.confirmed',title:'Contribution confirmed',body:'Folake confirmed your ₦15,000 payment to August Rent Pool',is_read:false,created_at:'2026-08-22T09:14:00Z'} as Notification,
  {id:'ntf_002',type:'task.assigned',title:'New task assigned',body:'You were assigned "Pick up grandma\'s medication"',is_read:false,created_at:'2026-08-21T18:00:00Z'} as Notification,
  {id:'ntf_003',type:'dispute.raised',title:'Dispute raised',body:'Bisi raised a dispute on ledger entry #2180',is_read:false,created_at:'2026-08-19T20:10:00Z'} as Notification,
  {id:'ntf_004',type:'container.reminder',title:'Payment reminder',body:'Christmas Trip Fund contribution due in 3 days',is_read:true,created_at:'2026-08-18T08:00:00Z'} as Notification,
  {id:'ntf_005',type:'task.confirmed',title:'Task confirmed',body:'Folake confirmed "Renew family WAEC prep subscription"',is_read:true,created_at:'2026-08-16T13:47:00Z'} as Notification,
  {id:'ntf_006',type:'container.completed',title:'Pool completed',body:'July Rent Pool has been marked complete — ₦90,000 collected',is_read:true,created_at:'2026-08-01T09:00:00Z'} as Notification,
];
export function NotificationDrawer(){
  const{notificationDrawerOpen,setNotificationDrawerOpen}=useUIStore();
  const[notifications,setNotifications]=useState<Notification[]>(MOCK_NOTIFICATIONS);
  const isLoading=false;
  const hasNextPage=false;
  const isFetchingNextPage=false;
  const markAllPending=false;
  const handleMarkAll=()=>setNotifications(prev=>prev.map(n=>({...n,is_read:true})));
  return(<>
    {notificationDrawerOpen&&<div className="fixed inset-0 bg-black/20 z-40" onClick={()=>setNotificationDrawerOpen(false)}/>}
    <div className={cn('fixed top-0 right-0 h-full w-full max-w-sm bg-white border-l border-border z-50 flex flex-col shadow-2xl transition-transform duration-300',notificationDrawerOpen?'translate-x-0':'translate-x-full')}>
      <div className="flex items-center justify-between px-4 py-4 border-b border-border flex-shrink-0"><h2 className="font-bold text-text-primary">Notifications</h2><div className="flex items-center gap-2">{notifications.some(n=>!n.is_read)&&<Button variant="ghost" size="sm" onClick={handleMarkAll} loading={markAllPending}><CheckCheck size={14}/>Mark all read</Button>}<button onClick={()=>setNotificationDrawerOpen(false)} className="p-1.5 rounded-lg hover:bg-slate-100"><X size={18}/></button></div></div>
      <div className="flex-1 overflow-y-auto">{isLoading&&<div className="flex justify-center py-12"><Spinner/></div>}{!isLoading&&notifications.length===0&&<p className="text-center text-sm text-text-secondary py-12">You're all caught up 🎉</p>}{notifications.map(n=><NotificationItem key={n.id} notification={n} onClose={()=>setNotificationDrawerOpen(false)}/>)}{hasNextPage&&<div className="p-4 text-center"><Button variant="ghost" size="sm" loading={isFetchingNextPage} onClick={()=>{}}>Load more</Button></div>}</div>
    </div>
  </>);
}
