'use client';

import { createContext, useContext, useEffect, useState, useRef, ReactNode } from 'react';
import { createClient } from '@/lib/supabase-browser';
import type { User } from '@supabase/supabase-js';
import type { Profile } from '@/lib/types';
import { resolveFeatures, type FeatureKey } from '@/lib/features';

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
  hasFeature: (feature: FeatureKey) => boolean;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null, profile: null, isAdmin: false, isProduction: false, isGraphicsProduction: false, isSales: false, isCustomer: false, isInstaller: false, isFieldTech: false, isShopTech: false, hasRole: () => false, hasFeature: () => false, loading: true, signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [featureOverrides, setFeatureOverrides] = useState<{ feature: string; granted: boolean }[]>([]);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  const supabase = createClient();

  const loadProfileAndOverrides = async (userId: string) => {
    const [profileRes, overridesRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
      supabase.from('user_feature_overrides').select('feature, granted').eq('user_id', userId),
    ]);
    if (mountedRef.current) {
      setProfile(profileRes.data);
      setFeatureOverrides(overridesRes.data || []);
    }
  };

  useEffect(() => {
    mountedRef.current = true;

    const init = async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        const session = data?.session;
        if (!mountedRef.current) return;
        const u = session?.user ?? null;
        setUser(u);
        if (u) {
          loadProfileAndOverrides(u.id).catch(() => {});
        }
      } catch (e: any) {
        console.error('[AUTH] Init error:', e.message);
      }
      if (mountedRef.current) setLoading(false);
    };
    init();

    const { data } = supabase.auth.onAuthStateChange(async (event: any, session: any) => {
      if (!mountedRef.current) return;
      const u = session?.user ?? null;
      setUser(u);
      if (!u) {
        setProfile(null);
        setFeatureOverrides([]);
      } else if (event === 'SIGNED_IN') {
        loadProfileAndOverrides(u.id).catch(() => {});
      }
      if (mountedRef.current) setLoading(false);
    });

    return () => {
      mountedRef.current = false;
      data?.subscription?.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setFeatureOverrides([]);
  };

  // Multi-role check
  const rawRoles = profile?.roles?.length ? profile.roles : (profile?.role ? [profile.role] : []);
  const userRoles = rawRoles.map((r: string) => r === 'production' ? 'graphics_production' : r);
  const hasRole = (r: string) => userRoles.includes(r as any) || (r === 'production' && userRoles.includes('graphics_production'));
  const isAdmin = hasRole('admin');
  const isGraphicsProduction = hasRole('graphics_production') || isAdmin;
  const isProduction = isGraphicsProduction;
  const isSales = hasRole('sales') || isAdmin;
  const isCustomer = hasRole('customer');
  const isInstaller = hasRole('installer') || isAdmin;
  const isFieldTech = hasRole('field_tech') || isAdmin;
  const isShopTech = hasRole('shop_tech') || isAdmin;

  // Feature access — resolved from roles + per-user overrides
  const features = resolveFeatures(userRoles, featureOverrides);
  const hasFeature = (feature: FeatureKey) => features.has(feature);

  return (
    <AuthContext.Provider value={{ user, profile, isAdmin, isProduction, isGraphicsProduction, isSales, isCustomer, isInstaller, isFieldTech, isShopTech, hasRole, hasFeature, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
