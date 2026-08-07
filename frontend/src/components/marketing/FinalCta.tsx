import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { ROUTES } from '@/app/router/routes';
import { Container } from '@/components/common/Container';
import { Button } from '@/components/ui/Button';
import { useReveal } from '@/hooks/useReveal';

/**
 * One sentence, one button. The closing CTA is where landing pages usually
 * pile on a gradient panel and three reassurance badges; the restraint is the
 * point, and by this scroll depth the reader has already decided.
 */
export function FinalCta() {
  const ref = useReveal<HTMLElement>();

  return (
    <section ref={ref} className="reveal border-t border-line bg-subtle py-24 sm:py-28">
      <Container>
        <div className="mx-auto max-w-xl text-center">
          <h2 className="text-h2 sm:text-h1">Start with one document.</h2>
          <p className="mt-4 text-body-lg text-secondary text-pretty">
            Upload a contract you have been meaning to read properly, and ask it the question
            you actually care about.
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild variant="primary" size="lg" className="w-full sm:w-auto">
              <Link to={ROUTES.signup}>
                Create your account
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="secondary" size="lg" className="w-full sm:w-auto">
              <Link to={ROUTES.login}>Sign in</Link>
            </Button>
          </div>

          <p className="mt-5 text-caption text-tertiary">
            Free while in early access · No credit card required
          </p>
        </div>
      </Container>
    </section>
  );
}
