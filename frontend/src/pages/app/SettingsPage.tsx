import type { ReactNode } from 'react';
import { useSession } from '@/app/providers/SessionProvider';
import { useTheme } from '@/app/providers/ThemeProvider';
import { formatBytesOf } from '@/lib/utils/format';
import { PageContainer } from '@/components/layout/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Meter } from '@/components/ui/Meter';

/**
 * A definition row. Label left, value right, hairline between — the densest
 * legible way to present read-only account facts, and the pattern the real
 * settings forms will replace one row at a time.
 */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-line px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <dt className="text-body-sm text-secondary">{label}</dt>
      <dd className="text-body-sm text-primary">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-body-sm font-medium text-primary">{title}</h2>
      <Card className="mt-3 overflow-hidden">
        <dl>{children}</dl>
      </Card>
    </section>
  );
}

export function SettingsPage() {
  const { user } = useSession();
  const { preference, theme } = useTheme();
  const { usedBytes, limitBytes, documentCount } = user.storage;

  return (
    <PageContainer title="Settings" width="prose">
      <PageHeader
        title="Settings"
        description="Account details and workspace preferences."
      />

      <Section title="Profile">
        <Row label="Name">{user.name}</Row>
        <Row label="Email">
          <span className="flex items-center gap-2">
            {user.email}
            {user.emailVerified && (
              <Badge variant="success" size="sm">
                Verified
              </Badge>
            )}
          </span>
        </Row>
        <Row label="Plan">{user.plan}</Row>
      </Section>

      <Section title="Appearance">
        <Row label="Theme">
          <span className="capitalize">
            {preference === 'system' ? `System (${theme})` : preference}
          </span>
        </Row>
      </Section>

      <Section title="Storage">
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
      </Section>
    </PageContainer>
  );
}
