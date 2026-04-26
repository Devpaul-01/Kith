import{Navigate,Outlet}from'react-router-dom';import{useIsAdmin}from'@/hooks/useIsAdmin';
export function AdminRoute(){const isAdmin=useIsAdmin();if(!isAdmin)return<Navigate to="/app/dashboard" replace/>;return<Outlet/>;}
