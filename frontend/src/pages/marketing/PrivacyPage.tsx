import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { LegalPage, type LegalSection } from '@/components/common/LegalPage';
import { TextLink } from '@/components/ui/TextLink';
import { ROUTES } from '@/app/router/routes';

/**
 * Written to match what the system actually does — see docs/00-product.md §4
 * and docs/04-data-and-api.md. A policy that promises more than the
 * architecture enforces is worse than no policy.
 */
const SECTIONS: LegalSection[] = [
  {
    id: 'what-we-collect',
    heading: 'What we collect',
    body: (
      <>
        <p>Three categories, and nothing outside them:</p>
        <ul>
          <li>
            <strong>Account data.</strong> Your email address, display name, and a hash of your
            password. We never store your password itself.
          </li>
          <li>
            <strong>Content you upload.</strong> The documents you add to your knowledge base,
            the text extracted from them, and the numerical representations (embeddings) used
            to search them.
          </li>
          <li>
            <strong>Usage data.</strong> Your conversations, and operational records such as
            request timing, error codes, and token counts. These records reference identifiers
            and counts — not the content of your documents.
          </li>
        </ul>
        <p>
          We do not use third-party advertising or analytics trackers, and we do not build a
          profile of you across other websites.
        </p>
      </>
    ),
  },
  {
    id: 'how-we-use-it',
    heading: 'How we use it',
    body: (
      <>
        <p>
          Your content is used to operate the service for you: to index your documents so they
          can be searched, to answer your questions, and to keep your conversation history
          available to you.
        </p>
        <p>
          <strong>We do not use your documents to train any model</strong> — neither ours nor a
          provider&rsquo;s. We do not read your documents, and no employee accesses your content
          except where you explicitly ask for support and grant access for that purpose.
        </p>
      </>
    ),
  },
  {
    id: 'model-providers',
    heading: 'What is sent to model providers',
    body: (
      <>
        <p>
          Lumora uses third-party large language model providers to generate answers and to
          create embeddings. Two things are sent to them, and only these:
        </p>
        <ul>
          <li>
            <strong>At upload:</strong> the text of your document, in passages, so it can be
            converted into embeddings.
          </li>
          <li>
            <strong>At question time:</strong> your question, recent conversation context, and
            the small number of passages retrieved as relevant — typically fewer than six. Your
            full library is never sent.
          </li>
        </ul>
        <p>
          We use providers under agreements that prohibit training on data submitted through
          their API. Your account identity is not shared with them.
        </p>
      </>
    ),
  },
  {
    id: 'storage-and-security',
    heading: 'Storage and security',
    body: (
      <>
        <p>
          Data is encrypted in transit. Passwords are hashed with argon2id. Sessions use
          short-lived access tokens with rotating refresh tokens, and reuse of a rotated token
          revokes the entire session family.
        </p>
        <p>
          Every document, passage, and conversation is scoped to the account that created it at
          the data-access layer, so isolation does not depend on a filter being remembered at
          each call site.
        </p>
        <p>
          No system is perfectly secure, and we will not claim otherwise. If we become aware of
          a breach affecting your data, we will notify you without undue delay.
        </p>
      </>
    ),
  },
  {
    id: 'retention',
    heading: 'Retention and deletion',
    body: (
      <>
        <p>
          Your content is kept until you delete it. Deleting a document removes the stored file,
          its extracted text, its passages, and its embeddings. There is no soft-delete state
          that retains your content after you have asked for it to be removed.
        </p>
        <p>
          Conversations you have already had remain readable and retain a snapshot of the
          passage that was cited at the time, so your history does not silently change. Deleting
          a conversation removes those snapshots with it.
        </p>
        <p>
          Deleting your account removes all of the above. Operational logs that contain no
          document content are retained for a limited period for security and reliability
          purposes.
        </p>
      </>
    ),
  },
  {
    id: 'your-rights',
    heading: 'Your rights',
    body: (
      <>
        <p>
          You can access, correct, export, and delete your data from within the product at any
          time. Depending on where you live, you may also have the right to object to or
          restrict certain processing, and to lodge a complaint with a supervisory authority.
        </p>
        <p>
          To exercise a right that is not available in the interface, email{' '}
          <a
            href="mailto:privacy@lumora.app"
            className="rounded-xs text-accent underline decoration-transparent underline-offset-[3px] transition-colors hover:decoration-current"
          >
            privacy@lumora.app
          </a>
          .
        </p>
      </>
    ),
  },
  {
    id: 'cookies',
    heading: 'Cookies',
    body: (
      <>
        <p>
          Lumora sets one cookie: an HTTP-only session cookie holding your refresh token. It is
          strictly necessary to keep you signed in, and it is why there is no cookie banner —
          there is nothing optional to consent to.
        </p>
        <p>
          Your theme preference is stored in your browser&rsquo;s local storage and never
          transmitted.
        </p>
      </>
    ),
  },
  {
    id: 'changes',
    heading: 'Changes to this policy',
    body: (
      <p>
        If we make a material change to how we handle your data, we will notify you by email
        before it takes effect. The date at the top of this page always reflects the current
        version. Continued use after a change means you accept it; if you do not, you can export
        your data and delete your account. See also our{' '}
        <TextLink to={ROUTES.terms}>Terms of Service</TextLink>.
      </p>
    ),
  },
];

export function PrivacyPage() {
  useDocumentTitle('Privacy Policy — Lumora');

  return (
    <LegalPage
      title="Privacy Policy"
      lastUpdated="5 August 2026"
      summary="You upload private documents, so here is the short version: we do not train on them, we send only the passages needed to answer your question, and when you delete something it is actually gone."
      sections={SECTIONS}
    />
  );
}
