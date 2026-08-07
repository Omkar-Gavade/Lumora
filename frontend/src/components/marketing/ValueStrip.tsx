import { Container } from '@/components/common/Container';
import { useReveal } from '@/hooks/useReveal';

/**
 * Three factual statements in place of a logo wall. Lumora has no customers to
 * name yet, and inventing them would be the one thing that discredits every
 * other claim on the page. An honest empty slot beats a fabricated one.
 *
 * Dividers are vertical hairlines rather than three cards — cards this early
 * would set up a card-grid rhythm the rest of the page then has to fight.
 */
const VALUES = [
  {
    stat: 'Grounded',
    body: 'Answers are assembled from passages retrieved out of your own files — not from model memory.',
  },
  {
    stat: 'Traceable',
    body: 'Every claim carries a citation. One click shows the source text it was drawn from.',
  },
  {
    stat: 'Private',
    body: 'Your documents are never used for training, and deleting one removes it from the index.',
  },
];

export function ValueStrip() {
  const ref = useReveal();

  return (
    <div ref={ref} className="reveal border-y border-line bg-subtle">
      <Container>
        <dl className="grid divide-y divide-[var(--border-subtle)] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {VALUES.map((value) => (
            <div key={value.stat} className="px-0 py-8 sm:px-8 sm:py-10 sm:first:pl-0 sm:last:pr-0">
              <dt className="font-serif text-h3 text-primary">{value.stat}</dt>
              <dd className="mt-2 text-body-sm text-secondary text-pretty">{value.body}</dd>
            </div>
          ))}
        </dl>
      </Container>
    </div>
  );
}
