// components/layout/Sidebar.tsx
import { NavLink } from 'react-router-dom';
import { 
  LayoutDashboard, 
  Box, 
  Users, 
  Flag, 
  Clock, 
  Bell, 
  Settings, 
  Users2, 
  X,
  Building2,
  Activity,  // ← Add this import for Activities
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useUIStore } from '@/store/uiStore';

export function Sidebar() {
  const isAdmin = useIsAdmin();
  const { workspace } = useWorkspace();
  const { sidebarOpen, setSidebarOpen } = useUIStore();

  const links = [
    { to: '/app/dashboard', label: 'Dashboard', Icon: LayoutDashboard },
    { to: '/app/containers', label: 'Events & Pools', Icon: Box },
    { to: '/app/members', label: 'Members', Icon: Users },
    { to: '/app/timeline', label: 'Timeline', Icon: Clock },
    { to: '/app/notifications', label: 'Notifications', Icon: Bell },
    ...(isAdmin ? [
      { to: '/app/groups', label: 'Groups', Icon: Users2 },
      { to: '/app/disputes', label: 'Disputes', Icon: Flag },
    ] : []),
    // Profile Settings (always visible)
    { to: '/app/settings/profile', label: 'Profile', Icon: Settings },  // ← Changed from '/app/settings'
    // Workspace Settings (admin only)
    ...(isAdmin ? [
      { to: '/app/settings/workspace', label: 'Workspace', Icon: Building2 },
      { to: '/app/activities', label: 'Activities', Icon: Activity },  // ← New Activities button
    ] : []),
  ];

  return (
    <>
      {sidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/30 z-30 lg:hidden" 
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={cn(
        'fixed top-0 left-0 h-full w-64 bg-white border-r border-border z-40 flex flex-col transition-transform duration-300',
        'lg:translate-x-0 lg:static lg:z-auto',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full'
      )}>
        <div className="h-16 flex items-center justify-between px-5 border-b border-border">
          <span className="text-xl font-extrabold text-text-primary">
            ki<span className="text-primary">th</span>
          </span>
          <button 
            className="lg:hidden p-1 rounded-lg hover:bg-slate-100" 
            onClick={() => setSidebarOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        
        {workspace && (
          <div className="px-4 py-3 border-b border-border">
            <p className="text-xs text-text-secondary font-medium uppercase tracking-wider">
              Workspace
            </p>
            <p className="text-sm font-semibold text-text-primary truncate mt-0.5">
              {workspace.name}
            </p>
          </div>
        )}
        
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {links.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) => cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors',
                isActive 
                  ? 'bg-primary-light text-primary' 
                  : 'text-text-secondary hover:bg-slate-100 hover:text-text-primary'
              )}
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
    </>
  );
}