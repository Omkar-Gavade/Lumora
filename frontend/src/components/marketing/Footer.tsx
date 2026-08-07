import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils/cn';
import { ROUTES, SECTIONS } from '@/app/router/routes';
import { Container } from '@/components/common/Container';
import { Logo } from '@/components/common/Logo';

interface FooterLink {
  label: string;
  to: string;
  external?: boolean;
}

const COLUMNS: { heading: string; links: FooterLink[] }[] = [
  {
    heading: 'Product',
    links: [
      { label: 'Features', to: `${ROUTES.home}#${SECTIONS.features}` },
      { label: 'How it works', to: `${ROUTES.home}#${SECTIONS.howItWorks}` },
      { label: 'Why RAG', to: `${ROUTES.home}#${SECTIONS.whyRag}` },
      { label: 'Use cases', to: `${ROUTES.home}#${SECTIONS.useCases}` },
    ],
  },
  {
    heading: 'Resources',
    links: [
      { label: 'FAQ', to: `${ROUTES.home}#${SECTIONS.faq}` },
      { label: 'Supported file types', to: `${ROUTES.home}#${SECTIONS.faq}` },
      { label: 'Changelog', to: `${ROUTES.home}#${SECTIONS.faq}` },
      { label: 'Status', to: `${ROUTES.home}#${SECTIONS.faq}` },
    ],
  },
  {
    heading: 'Company',
    links: [
      { label: 'Privacy & security', to: `${ROUTES.home}#${SECTIONS.privacy}` },
      { label: 'Privacy policy', to: ROUTES.privacy },
      { label: 'Terms of service', to: ROUTES.terms },
      { label: 'Contact', to: 'mailto:hello@lumora.app', external: true },
    ],
  },
];

const SOCIAL: { label: string; href: string; path: string }[] = [
  {
    label: 'GitHub',
    href: 'https://github.com',
    path: 'M12 2C6.48 2 2 6.58 2 12.23c0 4.52 2.87 8.35 6.84 9.7.5.1.68-.22.68-.49l-.01-1.72c-2.78.62-3.37-1.37-3.37-1.37-.46-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.34 1.12 2.91.86.09-.66.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.8-4.57 5.05.36.32.68.94.68 1.9l-.01 2.82c0 .27.18.6.69.49A10.03 10.03 0 0 0 22 12.23C22 6.58 17.52 2 12 2Z',
  },
  {
    label: 'X',
    href: 'https://x.com',
    path: 'M17.53 3h3.06l-6.69 7.65L21.75 21h-5.98l-4.7-6.14L5.7 21H2.64l7.15-8.18L2.25 3h6.13l4.25 5.62L17.53 3Zm-1.07 16.15h1.7L7.6 4.76H5.78l10.68 14.39Z',
  },
  {
    label: 'LinkedIn',
    href: 'https://linkedin.com',
    path: 'M6.94 8.4H3.56V21h3.38V8.4ZM5.25 3a1.96 1.96 0 1 0 0 3.92 1.96 1.96 0 0 0 0-3.92ZM21 13.72c0-3.4-1.82-4.98-4.24-4.98-1.96 0-2.83 1.08-3.32 1.83V8.4H10.1c.04.95 0 12.6 0 12.6h3.34v-7.04c0-.3.02-.6.11-.81.24-.6.79-1.22 1.72-1.22 1.21 0 1.7.92 1.7 2.28V21H21v-7.28Z',
  },
];

/**
 * The footer is the last impression, so it gets a section's worth of rhythm
 * rather than a strip of links. One hairline separates it from the page and
 * one more separates the legal bar — spacing does the rest of the work.
 */
export function Footer() {
  const year = new Date().getFullYear();

  const linkClass = cn(
    'inline-flex min-h-7 items-center rounded-xs text-body-sm text-secondary',
    'transition-colors duration-150 hover:text-primary',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
  );

  return (
    <footer className="border-t border-line bg-subtle">
      <Container className="py-16 lg:py-20">
        <div className="grid gap-12 lg:grid-cols-[1.4fr_repeat(3,1fr)] lg:gap-8">
          {/* Brand column. One honest line, not a mission statement. */}
          <div className="max-w-xs">
            <Logo asLink={false} />
            <p className="mt-4 text-body-sm text-secondary text-pretty">
              A private knowledge base you can question in plain language — with every answer
              traced back to the passage it came from.
            </p>

            <ul className="mt-6 flex items-center gap-1">
              {SOCIAL.map((item) => (
                <li key={item.label}>
                  <a
                    href={item.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label={`Lumora on ${item.label}`}
                    className={cn(
                      'grid size-9 place-items-center rounded-md text-tertiary',
                      'transition-colors duration-150 hover:bg-hover hover:text-primary',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                    )}
                  >
                    <svg viewBox="0 0 24 24" className="size-[1.125rem]" aria-hidden="true">
                      <path fill="currentColor" d={item.path} />
                    </svg>
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {COLUMNS.map((column) => (
            <nav key={column.heading} aria-label={column.heading}>
              <h2 className="font-sans text-caption font-semibold tracking-normal text-primary">
                {column.heading}
              </h2>
              <ul className="mt-4 space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.label}>
                    {link.external ? (
                      <a href={link.to} className={linkClass}>
                        {link.label}
                      </a>
                    ) : (
                      <Link to={link.to} className={linkClass}>
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-14 flex flex-col gap-4 border-t border-line pt-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-caption text-tertiary">
            © {year} Lumora. All rights reserved.
          </p>
          <p className="text-caption text-tertiary">
            Your documents are never used to train any model.
          </p>
        </div>
      </Container>
    </footer>
  );
}
