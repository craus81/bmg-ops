'use client';

import { createContext, useContext, useEffect, useState, useRef, ReactNode } from 'react';
import { createClient, createDataClient } from '@/lib/supabase-browser';
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
  const dataSupabase = createDataClient();

  useEffect(() => {
    mountedRef.current = true;

    // Safety timeout
    const timeout = setTimeout(() => {
      if (mountedRef.current && loading) {
        console.log('[AUTH] Timeout fallback');
        setLoading(false);
      }
    }, 3000);

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!mountedRef.current) return;
      console.log('[AUTH] Event:', event);
      clearTimeout(timeout);

      const u = session?.user ?? null;
      setUser(u);

      // Set loading false immediately — don't wait for profile
      if (mountedRef.current) setLoading(false);

      // Fetch profile in background using data client (no abort issues)
      if (u) {
        try {
          const { data: profileData } = await dataSupabase
            .from('profiles')
            .select('*')
            .eq('id', u.id)
            .maybeSingle();
          console.log('[AUTH] Profile loaded:', profileData?.full_name);
          if (mountedRef.current) setProfile(profileData);
        } catch (e: any) {
          console.error('[AUTH] Profile error:', e.name, e.message);
        }
      } else {
        setProfile(null);
      }
    });

    return () => {
      mountedRef.current = false;
      clearTimeout(timeout);
      subscription.unsubscribe();
    };
  }, []);

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
