import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The shell, drawn but not yet alive.
 *
 * Shown while the app's route chunk resolves, and later while the session is
 * being restored on a cold load. Its geometry is the real shell's geometry —
 * same 264px sidebar, same 56px header, same rules in the same places — so
 * when the actual layout arrives nothing moves. A generic centred spinner
 * would be less code and would cost a visible jump on every cold start.
 *
 * Deliberately sparse: five nav rows and a title bar, not a faithful
 * reproduction of every element. A skeleton detailed enough to be mistaken for
 * content is a skeleton that will be out of date within a sprint.
 *
 * `aria-busy` with a live region, so this is announced as loading rather than
 * as a page containing nothing.
 */
export function AppShellSkeleton() {
  return (
    <div className="flex h-dvh overflow-hidden bg-canvas" role="status" aria-busy="true">
      <span className="sr-only">Loading Lumora</span>

      <aside className="hidden w-[var(--sidebar-w)] shrink-0 border-r border-line bg-sidebar md:block">
        <div className="flex h-[var(--app-header-h)] items-center border-b border-line px-4">
          <Skeleton className="size-6 rounded-md" />
          <Skeleton className="ml-2.5 h-4 w-20" />
        </div>

        <div className="px-3 pt-3">
          <Skeleton className="h-9 w-full" />
        </div>

        <div className="flex flex-col gap-1.5 px-3 pt-8">
          <Skeleton className="mb-1 h-3 w-16" />
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-9 w-full" />
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[var(--app-header-h)] shrink-0 items-center gap-3 border-b border-line px-4">
          <Skeleton className="size-9 md:hidden" />
          <Skeleton className="h-4 w-28" />
          <div className="ml-auto flex items-center gap-2">
            <Skeleton className="hidden h-9 w-56 lg:block" />
            <Skeleton className="size-7 rounded-full" />
          </div>
        </div>

        <div className="mx-auto w-full max-w-[var(--container-app)] px-4 pt-8 sm:px-6 lg:px-8">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="mt-3 h-4 w-full max-w-md" />
        </div>
      </div>
    </div>
  );
}
