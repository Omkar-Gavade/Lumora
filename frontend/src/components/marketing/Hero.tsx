import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { ROUTES, SECTIONS } from '@/app/router/routes';
import { Container } from '@/components/common/Container';
import { Button } from '@/components/ui/Button';
import { ProductPreview } from './ProductPreview';

/**
 * Centered, single-column, and deliberately restrained. No oversized slogan —
 * the headline is a plain statement of what the software does, and the product
 * screenshot carries the persuasion.
 */
export function Hero() {
  return (
    // Top padding is tighter on phones: 128px of empty canvas above the fold
    // costs a quarter of an 844px viewport before a single word is read.
    <section className="relative pt-24 pb-16 sm:pt-40 sm:pb-20 lg:pt-44">
      <Container>
        <div className="mx-auto max-w-3xl text-center">
          <p className="mb-6 text-micro font-medium tracking-[0.08em] text-tertiary uppercase">
            Retrieval-augmented knowledge base
          </p>

          <h1 className="text-[2.5rem] leading-[1.08] tracking-[-0.03em] text-balance sm:text-[3.25rem] lg:text-[3.75rem]">
            Ask your documents anything.
          </h1>

          <p className="mx-auto mt-6 max-w-xl text-body-lg text-secondary text-pretty">
            Lumora reads your PDFs, contracts, and notes, then answers questions about them —
            with citations pointing to the exact passage it used. When your documents
            don&rsquo;t cover something, it says so instead of guessing.
          </p>

          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild variant="primary" size="lg" className="w-full sm:w-auto">
              <Link to={ROUTES.signup}>
                Get started free
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="secondary" size="lg" className="w-full sm:w-auto">
              <a href={`#${SECTIONS.howItWorks}`}>See how it works</a>
            </Button>
          </div>

          {/* Honest scope, stated where the claim is made rather than buried
              in an FAQ. */}
          <p className="mt-5 text-caption text-tertiary">
            PDF, DOCX, TXT, and Markdown · No credit card required
          </p>
        </div>

        <div className="mt-16 sm:mt-20">
          <ProductPreview />
        </div>
      </Container>
    </section>
  );
}
