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
  const initializedRef = useRef(false);
  const supabase = createClient();

  useEffect(() => {
    mountedRef.current = true;

    // Safety timeout — if nothing fires in 3 seconds, stop loading
    const timeout = setTimeout(() => {
      if (mountedRef.current && loading && !initializedRef.current) {
        console.log('[AUTH] Timeout — no auth event received, setting loading false');
        initializedRef.current = true;
        setLoading(false);
      }
    }, 3000);

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!mountedRef.current) return;
      console.log('[AUTH] Event:', event, 'User:', session?.user?.email || 'none');
      initializedRef.current = true;
      clearTimeout(timeout);

      try {
        const u = session?.user ?? null;
        setUser(u);
        if (u) {
          const { data: profileData } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', u.id)
            .maybeSingle();
          if (mountedRef.current) setProfile(profileData);
        } else {
          setProfile(null);
        }
      } catch (e: any) {
        console.error('[AUTH] Error:', e.name, e.message);
      }
      if (mountedRef.current) setLoading(false);
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
