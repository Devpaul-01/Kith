import{Navigate,Outlet}from'react-router-dom';import{useEffect,useState}from'react';import{useAuthStore}from'@/store/authStore';import{authService}from'@/services/auth.service';import{Spinner}from'@/components/ui/Spinner';import type{User,Membership}from'@/types/models';
export function ProfileGuard(){
  const{dbUser,session,setDbUser}=useAuthStore();
  const[checking,setChecking]=useState(!dbUser);
  useEffect(()=>{
    if(!dbUser&&session){authService.getMe().then((d:unknown)=>{const{user,memberships}=d as{user:User;memberships:Membership[]};if(user)setDbUser(user,memberships);}).catch(()=>{}).finally(()=>setChecking(false));}
    else{setChecking(false);}
  },[]);
  if(checking)return<div className="flex h-screen items-center justify-center"><Spinner size="lg"/></div>;
  if(!dbUser)return<Navigate to="/register" replace/>;
  return<Outlet/>;
}
