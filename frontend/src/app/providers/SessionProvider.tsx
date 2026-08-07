import { createContext, useContext, useMemo, type ReactNode } from 'react';

export interface StorageUsage {
  /** Bytes consumed by the user's indexed documents. */
  usedBytes: number;
  /** Bytes included in the plan. */
  limitBytes: number;
  documentCount: number;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  /** Plan label shown next to the account row. */
  plan: string;
  /** Absent for every user until avatar upload ships — `Avatar` falls back to
   *  initials, which is the state the design was drawn around anyway. */
  avatarUrl?: string;
  emailVerified: boolean;
  storage: StorageUsage;
}

interface SessionContextValue {
  user: SessionUser;
  signOut: () => void;
}

/**
 * Mocked session.
 *
 * The shape is the one `AuthProvider` will expose once the API exists
 * (docs/02-frontend.md §5.2), so swapping this for the real provider is a
 * change to this file only — no consumer moves. Deliberately not typed as
 * `user: SessionUser | null`: the shell only ever renders behind a guard, and
 * a nullable user would push a `user?.name` check into every component that
 * displays it, for a state none of them can actually be in.
 */
const MOCK_USER: SessionUser = {
  id: 'usr_8f2c1a',
  name: 'Omkar Gavade',
  email: 'omkar@ritindia.edu',
  plan: 'Pro',
  emailVerified: true,
  storage: {
    usedBytes: 1_288_490_189, // 1.2 GB
    limitBytes: 5_368_709_120, // 5 GB
    documentCount: 34,
  },
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const value = useMemo<SessionContextValue>(
    () => ({
      user: MOCK_USER,
      signOut: () => {
        // Real implementation clears the token and redirects. Left as a no-op
        // rather than a fake redirect, so the shell cannot pretend to do
        // something the backend has not been wired for yet.
        console.info('[Lumora] Sign out — pending auth integration.');
      },
    }),
    [],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used within <SessionProvider>');
  return context;
}
