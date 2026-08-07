import { SECTIONS } from '@/app/router/routes';
import { Section } from '@/components/common/Section';
import { SectionHeader } from '@/components/common/SectionHeader';

/**
 * Step 2 explains chunking and embeddings in one sentence on purpose.
 * Naming the mechanism costs a line and buys credibility with exactly the
 * audience most likely to distrust an AI product.
 */
const STEPS = [
  {
    title: 'Upload your documents',
    body: 'Drag in PDFs, Word files, plain text, or Markdown. Lumora extracts the text, keeping page numbers and section headings intact.',
    detail: 'PDF · DOCX · TXT · MD',
  },
  {
    title: 'Lumora indexes them',
    body: 'Each document is split into passages of a few hundred words on real boundaries — never mid-sentence — and each passage is converted into a vector that captures its meaning.',
    detail: 'Structure-aware chunking · Embeddings',
  },
  {
    title: 'Ask, then verify',
    body: 'Your question retrieves the handful of passages that actually address it. The model writes an answer from only those passages, and cites each one.',
    detail: 'Hybrid retrieval · Cited answers',
  },
];

export function HowItWorks() {
  return (
    <Section id={SECTIONS.howItWorks} tone="subtle" bordered>
      <SectionHeader
        eyebrow="How it works"
        title="Three steps, no configuration"
        description="There is no model to pick, no index to tune, and no prompt to write."
      />

      <ol className="mt-14 grid gap-10 md:grid-cols-3 md:gap-8">
        {STEPS.map((step, index) => (
          <li key={step.title} className="relative">
            {/* A hairline connecting the numerals, drawn only between steps.
                Cheaper and calmer than arrows or a decorative graphic. */}
            {index < STEPS.length - 1 && (
              <span
                aria-hidden="true"
                className="absolute top-[0.9375rem] left-[calc(2rem+0.75rem)] hidden h-px w-[calc(100%-2rem)] bg-line md:block"
              />
            )}

            <span className="relative z-10 inline-flex size-8 items-center justify-center rounded-full border border-line-default bg-canvas font-sans text-caption font-medium tabular-nums text-primary">
              {index + 1}
            </span>

            <h3 className="mt-5 text-h3">{step.title}</h3>
            <p className="mt-2.5 text-body-sm text-secondary text-pretty">{step.body}</p>
            <p className="mt-4 font-mono text-caption text-tertiary">{step.detail}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}
