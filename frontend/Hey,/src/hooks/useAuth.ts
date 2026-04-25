import{useAuthStore}from'@/store/authStore';
export function useAuth(){return useAuthStore();}
export function useSession(){return useAuthStore(s=>s.session);}
export function useDbUser(){return useAuthStore(s=>s.dbUser);}
export function useMemberships(){return useAuthStore(s=>s.memberships);}
