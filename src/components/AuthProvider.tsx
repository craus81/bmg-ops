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
    console.log('[AUTH] Starting auth check...');

    const getUser = async () => {
      try {
        console.log('[AUTH] Calling getSession...');
        const { data, error } = await supabase.auth.getSession();
        console.log('[AUTH] getSession returned:', { hasSession: !!data?.session, error });
        
        if (!mountedRef.current) {
          console.log('[AUTH] Component unmounted, bailing');
          return;
        }

        const u = data?.session?.user ?? null;
        console.log('[AUTH] User:', u?.email || 'none');
        setUser(u);

        if (u) {
          console.log('[AUTH] Fetching profile...');
          const { data: profileData, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', u.id)
            .maybeSingle();
          console.log('[AUTH] Profile result:', { profileData, profileError });
          if (mountedRef.current) setProfile(profileData);
        }
      } catch (e: any) {
        console.error('[AUTH] Error:', e.name, e.message);
      }
      console.log('[AUTH] Setting loading to false');
      if (mountedRef.current) setLoading(false);
    };
    getUser();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      console.log('[AUTH] Auth state changed:', _event);
      if (!mountedRef.current) return;
      try {
        setUser(session?.user ?? null);
        if (session?.user) {
          const { data: profileData } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', session.user.id)
            .maybeSingle();
          if (mountedRef.current) setProfile(profileData);
        } else {
          setProfile(null);
        }
      } catch (e: any) {
        console.error('[AUTH] State change error:', e.name, e.message);
      }
      if (mountedRef.current) setLoading(false);
    });

    return () => {
      console.log('[AUTH] Cleanup - unmounting');
      mountedRef.current = false;
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
