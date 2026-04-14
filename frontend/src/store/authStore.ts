import{create}from'zustand';import{persist}from'zustand/middleware';import type{User,Membership}from'@/types/models';
interface Session{access_token:string;refresh_token:string;expires_in:number;}
interface AuthState{session:Session|null;dbUser:User|null;memberships:Membership[];setSession:(a:string,r:string,e?:number)=>void;setDbUser:(u:User|null,m:Membership[])=>void;clear:()=>void;}
export const useAuthStore=create<AuthState>()(persist((set)=>({session:null,dbUser:null,memberships:[],setSession:(access_token,refresh_token,expires_in=3600)=>set({session:{access_token,refresh_token,expires_in}}),setDbUser:(dbUser,memberships)=>set({dbUser,memberships}),clear:()=>set({session:null,dbUser:null,memberships:[]})}),{name:'kith-auth',partialize:(s)=>({session:s.session})}));
