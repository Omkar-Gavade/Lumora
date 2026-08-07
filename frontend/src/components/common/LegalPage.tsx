import { type ReactNode } from 'react';
import { Container } from './Container';

export interface LegalSection {
  id: string;
  heading: string;
  body: ReactNode;
}

interface LegalPageProps {
  title: string;
  lastUpdated: string;
  summary: string;
  sections: LegalSection[];
}

/**
 * Legal pages are read, not skimmed, so they use the narrow prose measure
 * (704px ≈ 75 characters) rather than the marketing container.
 *
 * The plain-language summary at the top is deliberate: a policy nobody
 * finishes protects nobody. The numbered contents let a reader jump to the one
 * clause they came for.
 */
export function LegalPage({ title, lastUpdated, summary, sections }: LegalPageProps) {
  return (
    <article className="pt-32 pb-24 sm:pt-40">
      <Container width="prose">
        <header>
          <p className="text-micro font-medium tracking-[0.08em] text-tertiary uppercase">
            Last updated {lastUpdated}
          </p>
          <h1 className="mt-4 text-h1">{title}</h1>
          <p className="mt-5 border-l-2 border-line-strong pl-5 text-body text-secondary text-pretty">
            {summary}
          </p>
        </header>

        <nav aria-label="On this page" className="mt-12 border-y border-line py-6">
          <h2 className="font-sans text-caption font-semibold tracking-normal text-primary">
            Contents
          </h2>
          <ol className="mt-3 space-y-1.5">
            {sections.map((section, index) => (
              <li key={section.id} className="flex gap-3 text-body-sm">
                <span className="w-4 shrink-0 text-right tabular-nums text-tertiary">
                  {index + 1}
                </span>
                <a
                  href={`#${section.id}`}
                  className="rounded-xs text-secondary underline decoration-transparent underline-offset-[3px] transition-colors hover:text-primary hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {section.heading}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-12 space-y-12">
          {sections.map((section, index) => (
            <section key={section.id} id={section.id} className="scroll-mt-28">
              <h2 className="flex gap-3 text-h3">
                <span className="tabular-nums text-tertiary">{index + 1}.</span>
                {section.heading}
              </h2>
              <div className="mt-3 space-y-4 text-body-sm text-secondary [&_li]:text-pretty [&_p]:text-pretty [&_strong]:font-semibold [&_strong]:text-primary [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5">
                {section.body}
              </div>
            </section>
          ))}
        </div>
      </Container>
    </article>
  );
}
