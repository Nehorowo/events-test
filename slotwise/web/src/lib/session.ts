import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { get } from './api';
import type { Me, TenantInfo } from './types';

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/me'), staleTime: 60_000 });
}

const KEY = 'tenant';

export function storedTenantId(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function storeTenantId(id: string) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* ignore */
  }
}

/** The business the signed-in user is working in (first membership by default). */
export function useCurrentMembership() {
  const me = useMe();
  const memberships = me.data?.memberships ?? [];
  const wanted = storedTenantId();
  const current = memberships.find((m) => m.tenantId === wanted) ?? memberships[0] ?? null;
  return { me, current };
}

export function useTenantInfo(tenantId: string | undefined) {
  return useQuery({
    queryKey: ['tenant', tenantId],
    queryFn: () => get<TenantInfo>(`/t/${tenantId}`),
    enabled: Boolean(tenantId),
  });
}

/** Invalidate everything tenant-scoped after a write. */
export function useRefresh() {
  const qc = useQueryClient();
  return useCallback(
    (...keys: string[]) => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: [k] }))),
    [qc],
  );
}
