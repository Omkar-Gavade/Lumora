import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { LegalPage, type LegalSection } from '@/components/common/LegalPage';
import { TextLink } from '@/components/ui/TextLink';
import { ROUTES } from '@/app/router/routes';

const SECTIONS: LegalSection[] = [
  {
    id: 'agreement',
    heading: 'Agreement to these terms',
    body: (
      <p>
        By creating a Lumora account or using the service, you agree to these terms. If you are
        using Lumora on behalf of an organisation, you confirm you have authority to bind that
        organisation. If you do not agree, do not use the service.
      </p>
    ),
  },
  {
    id: 'accounts',
    heading: 'Your account',
    body: (
      <>
        <p>
          You must be at least 16 years old and provide an email address you control. You are
          responsible for keeping your credentials secure and for activity that occurs under
          your account.
        </p>
        <p>
          One person per account. If you believe your account has been accessed without your
          permission, change your password immediately — doing so signs out every other session.
        </p>
      </>
    ),
  },
  {
    id: 'your-content',
    heading: 'Your content stays yours',
    body: (
      <>
        <p>
          You retain all rights to the documents you upload. You grant us a limited licence to
          store, process, and index that content solely to provide the service to you. That
          licence ends when you delete the content.
        </p>
        <p>
          You confirm you have the right to upload what you upload, and that doing so does not
          infringe anyone else&rsquo;s rights or breach a confidentiality obligation you are
          under.
        </p>
      </>
    ),
  },
  {
    id: 'acceptable-use',
    heading: 'Acceptable use',
    body: (
      <>
        <p>You may not use Lumora to:</p>
        <ul>
          <li>upload content you do not have the right to use;</li>
          <li>store or process material that is illegal in your jurisdiction;</li>
          <li>
            attempt to access another account, circumvent quotas or rate limits, or probe the
            service for vulnerabilities outside a disclosed security programme;
          </li>
          <li>
            resell, redistribute, or provide the service to third parties as your own product;
          </li>
          <li>
            use automated means to extract the service&rsquo;s outputs at scale, or to train a
            competing model.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'accuracy',
    heading: 'Accuracy and your judgement',
    body: (
      <>
        <p>
          Lumora is designed to ground every answer in your documents and to cite its sources.
          It substantially reduces fabrication — it does not eliminate it. Retrieval can miss a
          relevant passage, and a model can misread one it was given.
        </p>
        <p>
          <strong>
            Answers are not legal, medical, financial, or professional advice, and you should
            verify anything consequential against the cited source.
          </strong>{' '}
          The citations exist precisely so that verification takes one click. You remain
          responsible for decisions you make based on output from the service.
        </p>
      </>
    ),
  },
  {
    id: 'availability',
    heading: 'Availability and changes',
    body: (
      <>
        <p>
          Lumora is in early access. We may add, change, or remove features, and there may be
          periods of downtime for maintenance or as a result of failures in systems we depend
          on, including model providers.
        </p>
        <p>
          We do not offer a service level guarantee during early access. If we discontinue the
          service, we will give you reasonable notice and time to export your data.
        </p>
      </>
    ),
  },
  {
    id: 'fees',
    heading: 'Fees',
    body: (
      <p>
        Lumora is free during early access, subject to the usage quotas shown in the product. If
        we introduce paid plans, we will give you notice before any charge applies, and existing
        content will not be held behind a paywall without an opportunity to export it.
      </p>
    ),
  },
  {
    id: 'termination',
    heading: 'Termination',
    body: (
      <>
        <p>
          You can delete your account at any time from your settings, which removes your content
          as described in our <TextLink to={ROUTES.privacy}>Privacy Policy</TextLink>.
        </p>
        <p>
          We may suspend or terminate an account that breaches these terms, or where required by
          law. Where circumstances reasonably allow, we will tell you why and give you a chance
          to export your data.
        </p>
      </>
    ),
  },
  {
    id: 'liability',
    heading: 'Disclaimers and liability',
    body: (
      <>
        <p>
          The service is provided &ldquo;as is&rdquo;. To the fullest extent permitted by law, we
          disclaim implied warranties of merchantability, fitness for a particular purpose, and
          non-infringement.
        </p>
        <p>
          To the fullest extent permitted by law, our aggregate liability arising from the
          service is limited to the greater of the amount you paid us in the preceding twelve
          months or USD 100. Nothing here limits liability that cannot be limited by law,
          including for death, personal injury, or fraud.
        </p>
      </>
    ),
  },
  {
    id: 'changes-to-terms',
    heading: 'Changes to these terms',
    body: (
      <p>
        We may update these terms. For material changes we will notify you by email at least 14
        days before they take effect. Continuing to use Lumora after that date means you accept
        the updated terms. Questions go to{' '}
        <a
          href="mailto:legal@lumora.app"
          className="rounded-xs text-accent underline decoration-transparent underline-offset-[3px] transition-colors hover:decoration-current"
        >
          legal@lumora.app
        </a>
        .
      </p>
    ),
  },
];

export function TermsPage() {
  useDocumentTitle('Terms of Service — Lumora');

  return (
    <LegalPage
      title="Terms of Service"
      lastUpdated="5 August 2026"
      summary="Your documents stay yours. Lumora cites its sources so you can check them, and you should — verify anything that matters against the cited passage before acting on it."
      sections={SECTIONS}
    />
  );
}
