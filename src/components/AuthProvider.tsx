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

    const getUser = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!mountedRef.current) return;
        const u = session?.user ?? null;
        setUser(u);
        if (u) {
          const { data } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', u.id)
            .maybeSingle();
          if (!mountedRef.current) return;
          setProfile(data);
        }
      } catch (e: any) {
        if (!mountedRef.current) return;
        console.error('Auth init error:', e);
      }
      if (mountedRef.current) setLoading(false);
    };
    getUser();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!mountedRef.current) return;
      try {
        setUser(session?.user ?? null);
        if (session?.user) {
          const { data } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', session.user.id)
            .maybeSingle();
          if (!mountedRef.current) return;
          setProfile(data);
        } else {
          setProfile(null);
        }
      } catch (e: any) {
        if (!mountedRef.current) return;
        console.error('Auth state error:', e);
      }
      if (mountedRef.current) setLoading(false);
    });

    return () => {
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
