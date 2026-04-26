
// store/authStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User, Membership } from '@/types/models';

// ✅ Access token only - refresh token stays in HTTP-only cookie
interface Session {
  access_token: string;
  expires_in: number;
}

interface AuthState {
  session: Session | null;
  dbUser: User | null;
  memberships: Membership[];
  setSession: (access_token: string, expires_in?: number) => void;  // No refresh_token param
  setDbUser: (u: User | null, m: Membership[]) => void;
  clear: () => void;
  refreshAccessToken: () => Promise<string | null>;  // New method
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      session: null,
      dbUser: null,
      memberships: [],
      
      setSession: (access_token, expires_in = 3600) => 
        set({ session: { access_token, expires_in } }),
      
      setDbUser: (dbUser, memberships) => 
        set({ dbUser, memberships }),
      
      clear: () => set({ session: null, dbUser: null, memberships: [] }),
      
      // ✅ New method to refresh access token using cookie
      refreshAccessToken: async () => {
        try {
          const response = await fetch('/v1/auth/refresh', {
            method: 'POST',
            credentials: 'include', // Important: sends cookies
          });
          
          if (!response.ok) throw new Error('Refresh failed');
          
          const data = await response.json();
          const { access_token, expires_in } = data;
          
          set({ session: { access_token, expires_in } });
          return access_token;
        } catch (error) {
          get().clear();
          return null;
        }
      },
    }),
    {
      name: 'kith-auth',
      // ✅ Only persist access_token (no refresh_token)
      partialize: (state) => ({ 
        session: state.session ? { 
          access_token: state.session.access_token, 
          expires_in: state.session.expires_in 
        } : null 
      }),
    }
  )
);

