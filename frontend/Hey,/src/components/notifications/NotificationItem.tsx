import{cn}from'@/utils/cn';import{timeAgo}from'@/utils/date';import type{Notification}from'@/types/models';import{useNavigate}from'react-router-dom';import{useMarkRead}from'@/hooks/useNotifications';
function resolveLink(n:Notification):string{switch(n.reference_type){case'ledger_entry':return`/app/containers/${n.reference_id}/ledger`;case'task':return`/app/containers/${n.reference_id}/tasks`;case'dispute':return`/app/disputes/${n.reference_id}`;default:return'/app/dashboard';}}
interface Props{notification:Notification;onClose:()=>void;}
export function NotificationItem({notification:n,onClose}:Props){
  const nav=useNavigate();const markRead=useMarkRead();
  function handleClick(){if(!n.is_read)markRead.mutate(n.id);nav(resolveLink(n));onClose();}
  return(<button onClick={handleClick} className={cn('w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors border-b border-border last:border-0',!n.is_read&&'bg-blue-50/40')}><div className="flex items-start gap-3">{!n.is_read&&<span className="mt-1.5 w-2 h-2 rounded-full bg-primary flex-shrink-0"/>}<div className={cn('flex-1 min-w-0',n.is_read&&'pl-5')}><p className="text-sm font-semibold text-text-primary leading-snug">{n.title}</p><p className="text-xs text-text-secondary mt-0.5 line-clamp-2">{n.body}</p><p className="text-xs text-slate-400 mt-1">{timeAgo(n.created_at)}</p></div></div></button>);
}
