import type { ReactNode } from 'react';
import { useAuthenticatedUser } from '@/app/providers/AuthProvider';
import { useTheme, type ThemePreference } from '@/app/providers/ThemeProvider';
import { formatBytesOf } from '@/lib/utils/format';
import { messageForError } from '@/constants/messages';
import { PageContainer } from '@/components/layout/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Meter } from '@/components/ui/Meter';
import { Skeleton } from '@/components/ui/Skeleton';
import { ProfileSection } from '@/features/settings/components/ProfileSection';
import { SecuritySection } from '@/features/settings/components/SecuritySection';
import { DangerSection } from '@/features/settings/components/DangerSection';
import { useUsage } from '@/features/settings/hooks/useAccount';

/**
 * Settings (docs/00-product.md §8.5, FR-34 – FR-37).
 *
 * One page with per-section cards rather than the nested `/settings/*` routes
 * §8.5 also describes. The section layout, save-per-section behaviour, and
 * separated danger zone are the parts that carry the requirements; splitting
 * them across four routes is a navigation change, and the brief asks to
 * preserve the existing navigation. The sections are already separate
 * components, so the split is a routing change later, not a rewrite.
 */

function Section({
  title,
  description,
  tone = 'default',
  children,
}: {
  title: string;
  description?: string;
  tone?: 'default' | 'danger';
  children: ReactNode;
}) {
  return (
    <section className="mt-8">
      <h2 className="text-body-sm font-medium text-primary">{title}</h2>
      {description !== undefined && (
        <p className="mt-1 text-body-sm text-secondary">{description}</p>
      )}
      <Card
        className={`mt-3 overflow-hidden ${tone === 'danger' ? 'border-danger' : ''}`}
      >
        {children}
      </Card>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-line px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <dt className="text-body-sm text-secondary">{label}</dt>
      <dd className="text-body-sm text-primary">{children}</dd>
    </div>
  );
}

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

function UsagePanel() {
  const usage = useUsage();

  if (usage.isPending) {
    return (
      <div className="space-y-3 px-5 py-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-2 w-full" />
      </div>
    );
  }

  if (usage.isError) {
    return (
      <div className="space-y-3 px-5 py-4">
        <Alert tone="error">{messageForError(usage.error)}</Alert>
        <Button variant="secondary" onClick={() => void usage.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const { usedBytes, limitBytes, documentCount } = usage.data;

  return (
    <>
      <Row label="Used">
        <span className="tabular">{formatBytesOf(usedBytes, limitBytes)}</span>
      </Row>
      <Row label="Documents">
        <span className="tabular">{documentCount}</span>
      </Row>
      <div className="px-5 py-4">
        <Meter
          value={limitBytes > 0 ? usedBytes / limitBytes : 0}
          label={`Storage used: ${formatBytesOf(usedBytes, limitBytes)}`}
        />
      </div>
    </>
  );
}

export function SettingsPage() {
  const user = useAuthenticatedUser();
  const { preference, setPreference } = useTheme();

  return (
    <PageContainer title="Settings" width="prose">
      <PageHeader title="Settings" description="Account details and workspace preferences." />

      <Section title="Profile">
        <ProfileSection user={user} />
      </Section>

      <Section
        title="Security"
        description="Changing your password signs you out on every device."
      >
        <SecuritySection />
      </Section>

      <Section title="Appearance">
        <div className="px-5 py-4">
          {/*
            A radiogroup, not a select. Three mutually exclusive options with
            short labels are faster to read and to operate by keyboard when
            they are all visible, and arrow-key traversal is the expected
            interaction — which native radios give for free.
          */}
          <fieldset>
            <legend className="text-body-sm text-secondary">Theme</legend>
            <div className="mt-3 flex flex-wrap gap-4">
              {THEMES.map((option) => (
                <label key={option.value} className="flex items-center gap-2 text-body-sm text-primary">
                  <input
                    type="radio"
                    name="theme"
                    value={option.value}
                    checked={preference === option.value}
                    onChange={() => { setPreference(option.value); }}
                    className="accent-[var(--accent)]"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </Section>

      <Section title="Storage">
        <dl>
          <UsagePanel />
        </dl>
      </Section>

      <Section
        title="Danger zone"
        description="Irreversible actions. Please be certain."
        tone="danger"
      >
        <DangerSection user={user} />
      </Section>
    </PageContainer>
  );
}
