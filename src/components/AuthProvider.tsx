'use client';

import { createContext, useContext, useEffect, useState, useRef, ReactNode } from 'react';
import { createClient } from '@/lib/supabase-browser';
import type { User } from '@supabase/supabase-js';
import type { Profile } from '@/lib/types';

interface AuthContextType {
  user: User | null;
  profile: Profile | null;
  isAdmin: boolean;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null, profile: null, isAdmin: false, loading: true, signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  const supabase = createClient();

  useEffect(() => {
    mountedRef.current = true;

    const init = async () => {
      try {
        console.log('[AUTH] Calling getSession...');
        const { data, error } = await supabase.auth.getSession();
        const session = data?.session;
        console.log('[AUTH] getSession result:', session ? 'HAS SESSION' : 'NO SESSION', error?.message || '');
        if (!mountedRef.current) return;
        const u = session?.user ?? null;
        setUser(u);

        // Load profile in background — don't block loading
        if (u) {
          supabase
            .from('profiles')
            .select('*')
            .eq('id', u.id)
            .maybeSingle()
            .then(({ data: profileData }: any) => {
              console.log('[AUTH] Profile loaded:', profileData?.full_name || 'null');
              if (mountedRef.current) setProfile(profileData);
            })
            .catch((e: any) => {
              console.error('[AUTH] Profile error:', e.message);
            });
        }
      } catch (e: any) {
        console.error('[AUTH] Init error:', e.message);
      }
      console.log('[AUTH] Setting loading=false');
      if (mountedRef.current) setLoading(false);
    };
    init();

    const { data } = supabase.auth.onAuthStateChange(async (event: any, session: any) => {
      console.log('[AUTH] onAuthStateChange:', event);
      if (!mountedRef.current) return;
      const u = session?.user ?? null;
      setUser(u);
      if (!u) setProfile(null);
      if (mountedRef.current) setLoading(false);
    });

    return () => {
      mountedRef.current = false;
      data?.subscription?.unsubscribe();
    };
  }, []);

  console.log('[AUTH] Render - loading:', loading, 'user:', user?.id || 'null');

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
  };

  return (
    <AuthContext.Provider value={{ user, profile, isAdmin: profile?.role === 'admin', loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
