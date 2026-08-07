import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { Hero } from '@/components/marketing/Hero';
import { ValueStrip } from '@/components/marketing/ValueStrip';
import { Features } from '@/components/marketing/Features';
import { HowItWorks } from '@/components/marketing/HowItWorks';
import { WhyRag } from '@/components/marketing/WhyRag';
import { UseCases } from '@/components/marketing/UseCases';
import { Privacy } from '@/components/marketing/Privacy';
import { Faq } from '@/components/marketing/Faq';
import { FinalCta } from '@/components/marketing/FinalCta';

/**
 * Section order is an argument, not a list:
 *   claim (Hero) → three supporting facts (ValueStrip) → what it does
 *   (Features) → how (HowItWorks) → why this approach at all (WhyRag) →
 *   who it is for (UseCases) → the objection (Privacy) → remaining
 *   objections (Faq) → ask (FinalCta).
 *
 * Layout alternates deliberately — centered, divided strip, bento, numbered
 * steps, asymmetric split, cards, split list, accordion — so no two adjacent
 * sections share a shape.
 */
export function HomePage() {
  useDocumentTitle('Lumora — Ask your documents anything');

  return (
    <>
      <Hero />
      <ValueStrip />
      <Features />
      <HowItWorks />
      <WhyRag />
      <UseCases />
      <Privacy />
      <Faq />
      <FinalCta />
    </>
  );
}
