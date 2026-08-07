import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { ROUTES, SECTIONS } from '@/app/router/routes';
import { Section } from '@/components/common/Section';

/**
 * Privacy gets a full section rather than a footer link, because for a product
 * that ingests private documents it is a purchase decision, not fine print.
 *
 * Every line is a commitment the architecture actually enforces. Nothing here
 * is aspirational — a promise the system cannot keep is worse than silence.
 */
const COMMITMENTS = [
  {
    title: 'Your documents are never used for training',
    body: 'Not ours, not a provider’s. Uploaded content is used to answer your questions and for nothing else.',
  },
  {
    title: 'Only the relevant passages leave storage',
    body: 'At question time Lumora sends the few retrieved passages to the model — never your whole library, and only for your own query.',
  },
  {
    title: 'Deleting is deleting',
    body: 'Removing a document erases the stored file, its extracted text, and its vectors. There is no soft-delete tombstone holding your content.',
  },
  {
    title: 'Isolated by account',
    body: 'Every document, passage, and conversation is scoped to the account that created it at the data-access layer, not by a filter someone can forget to apply.',
  },
];

export function Privacy() {
  return (
    <Section id={SECTIONS.privacy}>
      <div className="grid gap-12 lg:grid-cols-[0.8fr_1fr] lg:gap-16">
        <div>
          <p className="mb-4 text-micro font-medium tracking-[0.08em] text-tertiary uppercase">
            Privacy &amp; security
          </p>
          <h2 className="text-h2 sm:text-h1">You are uploading things that matter.</h2>
          <p className="mt-5 text-body text-secondary text-pretty">
            Contracts, medical records, unpublished research, internal policy. The only
            reasonable default is to tell you plainly what happens to them.
          </p>
          <Link
            to={ROUTES.privacy}
            className="mt-6 inline-flex items-center gap-1.5 rounded-xs text-body-sm text-accent underline decoration-transparent underline-offset-[3px] transition-colors hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Read the full privacy policy
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </Link>
        </div>

        {/* Divided list rather than four cards — this is a document, and it
            should read like one. */}
        <dl className="divide-y divide-[var(--border-subtle)] border-y border-line">
          {COMMITMENTS.map((commitment) => (
            <div key={commitment.title} className="py-6 first:pt-0 last:pb-0">
              <dt className="font-sans text-body-sm font-semibold text-primary">
                {commitment.title}
              </dt>
              <dd className="mt-1.5 text-body-sm text-secondary text-pretty">
                {commitment.body}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </Section>
  );
}
