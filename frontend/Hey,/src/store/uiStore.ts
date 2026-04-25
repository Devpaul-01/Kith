import{create}from'zustand';
interface UIState{sidebarOpen:boolean;notificationDrawerOpen:boolean;toggleSidebar:()=>void;setSidebarOpen:(v:boolean)=>void;toggleNotificationDrawer:()=>void;setNotificationDrawerOpen:(v:boolean)=>void;}
export const useUIStore=create<UIState>((set)=>({sidebarOpen:false,notificationDrawerOpen:false,toggleSidebar:()=>set(s=>({sidebarOpen:!s.sidebarOpen})),setSidebarOpen:(v)=>set({sidebarOpen:v}),toggleNotificationDrawer:()=>set(s=>({notificationDrawerOpen:!s.notificationDrawerOpen})),setNotificationDrawerOpen:(v)=>set({notificationDrawerOpen:v})}));
