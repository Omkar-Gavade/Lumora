import {
  FileSearch,
  Layers,
  MessageSquareQuote,
  ShieldOff,
  Trash2,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { SECTIONS } from '@/app/router/routes';
import { Section } from '@/components/common/Section';
import { SectionHeader } from '@/components/common/SectionHeader';
import { Card } from '@/components/ui/Card';

interface Feature {
  icon: LucideIcon;
  title: string;
  body: string;
}

/** The lead feature gets the wide cell and a small inline demonstration. */
const LEAD: Feature = {
  icon: MessageSquareQuote,
  title: 'Citations you can actually check',
  body: 'Answers carry inline markers tied to the passage they came from. Click one and the source panel opens on that exact chunk, highlighted, with the document name and page — not a link to a 200-page PDF for you to search yourself.',
};

const FEATURES: Feature[] = [
  {
    icon: ShieldOff,
    title: 'Knows when it doesn’t know',
    body: 'If retrieval finds nothing relevant, Lumora says so instead of filling the gap with plausible-sounding invention.',
  },
  {
    icon: FileSearch,
    title: 'Semantic and keyword search',
    body: 'Paraphrased questions and exact terms — clause numbers, part codes, surnames — both find the right passage.',
  },
  {
    icon: Layers,
    title: 'Follow-ups that hold context',
    body: '“What about the second one?” resolves against the conversation, so you never restate what you already asked.',
  },
  {
    icon: Zap,
    title: 'Streamed responses',
    body: 'Text appears as it is written, and you can stop generation at any point without losing what was already produced.',
  },
  {
    icon: Trash2,
    title: 'Deletes actually delete',
    body: 'Removing a document clears its text, its stored vectors, and its influence on every future answer.',
  },
];

function FeatureIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="mb-5 grid size-9 place-items-center rounded-lg border border-line bg-subtle text-primary">
      <Icon className="size-[1.125rem]" strokeWidth={1.5} aria-hidden="true" />
    </span>
  );
}

export function Features() {
  return (
    <Section id={SECTIONS.features}>
      <SectionHeader
        eyebrow="Features"
        title="Built for answers you can defend"
        description="Most of these exist because the alternative is an assistant that sounds confident and is quietly wrong."
      />

      {/* Restrained bento. The lead card is a 2×2 block, which makes the six
          items resolve to a full 3×3 with no gaps: lead fills rows 1–2 of
          columns 1–2, two cards stack in column 3, and the last three fill
          row 3. A 2×1 lead would leave one card stranded alone on a final
          row — the tell of a grid that ran out of content. */}
      <div className="mt-14 grid gap-4 md:grid-cols-3">
        <Card className="p-7 md:col-span-2 md:row-span-2 md:p-8">
          <FeatureIcon icon={LEAD.icon} />
          <h3 className="text-h3">{LEAD.title}</h3>
          <p className="mt-2.5 max-w-xl text-body-sm text-secondary text-pretty">{LEAD.body}</p>

          {/* A concrete instance of the claim directly above it. */}
          <div className="mt-6 rounded-lg border border-line bg-subtle/60 p-4">
            <p className="text-body-sm text-primary">
              Payment is due within 45 days of invoice date
              <span
                className={cn(
                  'ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-[3px] px-1',
                  'bg-accent-subtle align-super text-[0.5625rem] font-semibold text-accent',
                )}
              >
                1
              </span>
              .
            </p>
            <p className="mt-2.5 flex items-center gap-2 text-caption text-tertiary">
              <span className="inline-flex size-4 items-center justify-center rounded-[3px] bg-accent-subtle text-[0.5625rem] font-semibold text-accent">
                1
              </span>
              MSA-Northwind.pdf · p. 7 · §4.1 Invoicing
            </p>
          </div>
        </Card>

        {FEATURES.map((feature) => (
          <Card key={feature.title} className="p-7">
            <FeatureIcon icon={feature.icon} />
            <h3 className="text-h3">{feature.title}</h3>
            <p className="mt-2.5 text-body-sm text-secondary text-pretty">{feature.body}</p>
          </Card>
        ))}
      </div>
    </Section>
  );
}
