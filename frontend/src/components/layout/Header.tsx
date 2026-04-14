import{Menu,Bell}from'lucide-react';import{useUIStore}from'@/store/uiStore';import{useNotificationCount}from'@/hooks/useNotifications';import{Avatar}from'@/components/ui/Avatar';import{useDbUser}from'@/hooks/useAuth';import{WorkspaceSwitcher}from'./WorkspaceSwitcher';import{useNavigate}from'react-router-dom';
export function Header(){
  const{toggleSidebar,toggleNotificationDrawer}=useUIStore();const{data}=useNotificationCount();const user=useDbUser();const nav=useNavigate();
  const count=(data as{unread_count?:number})?.unread_count??0;
  return(<header className="h-16 bg-white border-b border-border flex items-center justify-between px-4 lg:px-6 sticky top-0 z-20"><div className="flex items-center gap-3"><button onClick={toggleSidebar} className="lg:hidden p-2 rounded-lg hover:bg-slate-100"><Menu size={20}/></button><WorkspaceSwitcher/></div>
    <div className="flex items-center gap-2"><button onClick={toggleNotificationDrawer} className="relative p-2 rounded-xl hover:bg-slate-100 text-text-secondary transition-colors"><Bell size={20}/>{count>0&&<span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] bg-danger text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">{count>99?'99+':count}</span>}</button>
      <button onClick={()=>nav('/app/settings')} className="flex items-center gap-2 p-1.5 rounded-xl hover:bg-slate-100 transition-colors"><Avatar src={user?.avatar_url} name={user?.full_name} size="sm"/><span className="hidden sm:block text-sm font-medium text-text-primary max-w-[120px] truncate">{user?.full_name}</span></button></div>
  </header>);
}
