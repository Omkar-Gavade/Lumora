import { Check, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { SECTIONS } from '@/app/router/routes';
import { Section } from '@/components/common/Section';

/**
 * Asymmetric two-column layout, deliberately breaking the centered rhythm of
 * the sections around it. The argument is a comparison, so the layout is a
 * comparison — a third card grid here would have flattened the point.
 */
export function WhyRag() {
  return (
    <Section id={SECTIONS.whyRag}>
      <div className="grid gap-12 lg:grid-cols-[0.85fr_1fr] lg:gap-16">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <p className="mb-4 text-micro font-medium tracking-[0.08em] text-tertiary uppercase">
            Why RAG
          </p>
          <h2 className="text-h2 sm:text-h1">
            A general model guesses. A grounded one retrieves.
          </h2>
          <div className="mt-5 space-y-4 text-body text-secondary text-pretty">
            <p>
              Language models are trained on public text up to a cutoff date. They have never
              seen your lease, your onboarding handbook, or last quarter&rsquo;s board deck — so
              when you ask about them, the model produces the most statistically plausible
              answer rather than the correct one.
            </p>
            <p>
              Retrieval-augmented generation closes that gap. Before answering, the system
              searches your own documents, pulls the few passages that address the question, and
              instructs the model to answer from those and nothing else.
            </p>
            <p>
              The cost stays flat as your library grows, deleting a document takes effect
              immediately, and — the part that matters most — every sentence can be traced back
              to a source.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <Comparison
            tone="bad"
            label="General chatbot"
            question="What's our refund window for enterprise plans?"
            answer="Most enterprise agreements provide a 30-day refund window, though this can vary by contract. You may want to check your specific agreement for details."
            verdict="Plausible, unsourced, and possibly wrong. The model has never read your agreement, so it is describing the industry average and hedging."
          />
          <Comparison
            tone="good"
            label="Lumora"
            question="What's our refund window for enterprise plans?"
            answer="Enterprise customers may request a full refund within 14 days of the initial invoice. After that, fees are non-refundable except where §9.3 applies."
            citation="Enterprise-Terms-v4.pdf · p. 5 · §6.2 Refunds"
            verdict="Drawn from your document, with the passage attached. If the answer is wrong, you can see exactly why in one click."
          />
        </div>
      </div>
    </Section>
  );
}

interface ComparisonProps {
  tone: 'good' | 'bad';
  label: string;
  question: string;
  answer: string;
  citation?: string;
  verdict: string;
}

function Comparison({ tone, label, question, answer, citation, verdict }: ComparisonProps) {
  const isGood = tone === 'good';

  return (
    <div
      className={cn(
        'rounded-xl border p-6',
        isGood ? 'border-line-strong bg-raised' : 'border-line bg-subtle/60',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'grid size-5 place-items-center rounded-full',
            isGood ? 'bg-accent-subtle text-accent' : 'bg-inset text-tertiary',
          )}
        >
          {isGood ? (
            <Check className="size-3 stroke-[2.5]" aria-hidden="true" />
          ) : (
            <X className="size-3 stroke-[2.5]" aria-hidden="true" />
          )}
        </span>
        <h3 className="font-sans text-caption font-semibold tracking-normal text-primary">
          {label}
        </h3>
      </div>

      <p className="mt-4 text-caption text-tertiary">{question}</p>
      <p
        className={cn(
          'mt-2 text-body-sm text-pretty',
          isGood ? 'text-primary' : 'text-secondary',
        )}
      >
        {answer}
      </p>

      {citation && (
        <p className="mt-3 flex items-center gap-2 text-caption text-tertiary">
          <span className="inline-flex size-4 items-center justify-center rounded-[3px] bg-accent-subtle text-[0.5625rem] font-semibold text-accent">
            1
          </span>
          {citation}
        </p>
      )}

      <p className="mt-5 border-t border-line pt-4 text-caption text-tertiary text-pretty">
        {verdict}
      </p>
    </div>
  );
}
