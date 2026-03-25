'use client';

import { createContext, useContext, useEffect, useState, useRef, ReactNode } from 'react';
import { createClient } from '@/lib/supabase-browser';
import type { User } from '@supabase/supabase-js';
import type { Profile } from '@/lib/types';

interface AuthContextType {
  user: User | null;
  profile: Profile | null;
  isAdmin: boolean;
  isProduction: boolean;
  isGraphicsProduction: boolean;
  isSales: boolean;
  isCustomer: boolean;
  isInstaller: boolean;
  isFieldTech: boolean;
  isShopTech: boolean;
  hasRole: (role: string) => boolean;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null, profile: null, isAdmin: false, isProduction: false, isGraphicsProduction: false, isSales: false, isCustomer: false, isInstaller: false, isFieldTech: false, isShopTech: false, hasRole: () => false, loading: true, signOut: async () => {},
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
      if (!u) {
        setProfile(null);
      } else if (event === 'SIGNED_IN') {
        // Re-fetch profile on sign-in (handles magic links, signup redirect, etc.)
        supabase
          .from('profiles')
          .select('*')
          .eq('id', u.id)
          .maybeSingle()
          .then(({ data: profileData }: any) => {
            if (mountedRef.current) setProfile(profileData);
          })
          .catch(() => {});
      }
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

  // Multi-role check: uses roles[] array if present, falls back to legacy role field
  // Map legacy 'production' role to 'graphics_production' for backward compatibility
  const rawRoles = profile?.roles?.length ? profile.roles : (profile?.role ? [profile.role] : []);
  const userRoles = rawRoles.map((r: string) => r === 'production' ? 'graphics_production' : r);
  const hasRole = (r: string) => userRoles.includes(r as any) || (r === 'production' && userRoles.includes('graphics_production'));
  const isAdmin = hasRole('admin');
  const isGraphicsProduction = hasRole('graphics_production') || isAdmin;
  const isProduction = isGraphicsProduction; // backward compat alias
  const isSales = hasRole('sales') || isAdmin;
  const isCustomer = hasRole('customer');
  const isInstaller = hasRole('installer') || isAdmin;
  const isFieldTech = hasRole('field_tech') || isAdmin;
  const isShopTech = hasRole('shop_tech') || isAdmin;

  return (
    <AuthContext.Provider value={{ user, profile, isAdmin, isProduction, isGraphicsProduction, isSales, isCustomer, isInstaller, isFieldTech, isShopTech, hasRole, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
