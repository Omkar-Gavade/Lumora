import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/app/providers/AuthProvider';
import { queryKeys } from '@/app/config/query-keys';
import {
  changePassword,
  deleteAccount,
  getUsage,
  updateProfile,
} from '../api/users.api';

/**
 * Account mutations (docs/02-frontend.md §6, Tier 3).
 *
 * Components never call the API functions directly, so cache invalidation and
 * session side effects live in one place instead of being repeated — and
 * forgotten — per caller.
 */

export function useUpdateProfile() {
  const client = useQueryClient();
  const { refreshUser } = useAuth();

  return useMutation({
    /*
      Wrapped rather than passed by reference. React Query calls `mutationFn`
      with a second context argument, which a bare reference forwards straight
      into the API function — harmless today, and exactly the kind of accidental
      extra parameter that becomes a bug when a signature grows.
    */
    mutationFn: (displayName: string) => updateProfile(displayName),
    onSuccess: async () => {
      /*
        Both, and in this order. The query cache backs anything reading
        `/auth/me` through React Query; `refreshUser` updates the AuthProvider
        context, which is what the sidebar avatar and greeting actually read.
        Updating only the cache leaves a stale name in the chrome until reload.
      */
      await client.invalidateQueries({ queryKey: queryKeys.auth.me() });
      await refreshUser();
    },
  });
}

/**
 * Changing the password revokes every session, including this one.
 *
 * The server bumps `token_version`, so the access token this request was made
 * with is dead the moment it returns. There is no way to stay signed in, and
 * pretending otherwise would leave the user clicking a UI whose next request
 * 401s. Signing out explicitly makes that a deliberate, explained transition
 * rather than a mysterious bounce to the login screen.
 */
export function useChangePassword() {
  return useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      changePassword(input),
  });
}

export function useDeleteAccount() {
  return useMutation({ mutationFn: (password: string) => deleteAccount(password) });
}

export function useUsage() {
  return useQuery({
    // Shared key with the documents feature: it is the same number from the
    // same endpoint family, and two keys would let the sidebar meter and this
    // panel disagree after an upload.
    queryKey: queryKeys.documents.usage(),
    queryFn: getUsage,
  });
}
