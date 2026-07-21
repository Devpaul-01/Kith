import{Navigate,Outlet,useLocation}from'react-router-dom';import{useAuthStore}from'@/store/authStore';
export function LandingRoute(){const session=useAuthStore(s=>s.session);const location=useLocation();if(session)return<Navigate to="/app/dashboard" state={{from:location}} replace/>;return<Outlet/>;}
