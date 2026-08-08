import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthSessionDto, UserDto } from '@lumora/shared';
import { refreshSession, setAccessToken, setSessionExpiredHandler } from '@/lib/api/client';
import * as authApi from '@/features/auth/api/auth.api';

/**
 * `loading` is a real state, not a boolean flag on the side.
 *
 * A cold load has to attempt a silent refresh before it knows whether there is
 * a session, and during that window the answer is neither "signed in" nor
 * "signed out". Modelling it as `user: null` would make every guard redirect
 * to /login for a few hundred milliseconds and then bounce back — the classic
 * flash that makes an app feel broken on every reload.
 */
export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: UserDto | null;
  /** Adopts a session returned by signup, login, or verification. */
  adoptSession: (session: AuthSessionDto) => void;
  signOut: () => Promise<void>;
  /** Re-reads `/auth/me` — used after an action that changes the user. */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Session state (docs/02-frontend.md §5.2).
 *
 * The access token is deliberately **not** here — it lives in a module
 * variable inside the API client. Keeping it out of React state is what stops
 * a token refresh from re-rendering every consumer of this context for a value
 * no component displays.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<UserDto | null>(null);

  const adoptSession = useCallback((session: AuthSessionDto) => {
    setAccessToken(session.accessToken);
    setUser(session.user);
    setStatus('authenticated');
  }, []);

  const signOut = useCallback(async () => {
    await authApi.logout();
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  const refreshUser = useCallback(async () => {
    const current = await authApi.getCurrentUser();
    setUser(current);
  }, []);

  /*
    Session restoration.

    The access token died with the last page, but the refresh cookie did not —
    so a cold load asks for a new access token before deciding anything. This
    is what makes "keep me signed in" work at all, and it is why the token is
    allowed to be memory-only in the first place: the cost of losing it on
    reload is one silent request.
  */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const restored = await refreshSession();

      if (!restored) {
        if (!cancelled) setStatus('unauthenticated');
        return;
      }

      try {
        const current = await authApi.getCurrentUser();
        if (cancelled) return;
        setUser(current);
        setStatus('authenticated');
      } catch {
        // The refresh succeeded but the user could not be read — treat it as
        // no session rather than as a half-signed-in state nothing can render.
        if (cancelled) return;
        setAccessToken(null);
        setStatus('unauthenticated');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /*
    The interceptor calls this when a refresh fails terminally — a revoked
    family, a reused token, an expired session. Registering a callback rather
    than having the client import React keeps `lib/` free of framework
    dependencies (docs/02-frontend.md §2).
  */
  useEffect(() => {
    setSessionExpiredHandler(() => {
      setUser(null);
      setStatus('unauthenticated');
    });
    return () => {
      setSessionExpiredHandler(null);
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, adoptSession, signOut, refreshUser }),
    [status, user, adoptSession, signOut, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within <AuthProvider>');
  return context;
}

/**
 * For components that only render behind `ProtectedRoute` and would otherwise
 * need a `user?.` check for a state they cannot be in.
 */
export function useAuthenticatedUser(): UserDto {
  const { user } = useAuth();
  if (!user) throw new Error('useAuthenticatedUser used outside an authenticated route');
  return user;
}
