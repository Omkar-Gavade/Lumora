import { SECTIONS } from '@/app/router/routes';
import { Section } from '@/components/common/Section';
import { SectionHeader } from '@/components/common/SectionHeader';
import { Accordion, type AccordionItem } from '@/components/common/Accordion';

/**
 * Answered without marketing evasion, including the two questions a vendor
 * normally dodges: whether it hallucinates, and what happens to your data.
 * Ducking those is what makes an FAQ read as PR.
 */
const FAQ_ITEMS: AccordionItem[] = [
  {
    question: 'Which file types can I upload?',
    answer:
      'PDF, DOCX, plain text, and Markdown. Spreadsheets, slide decks, and URL imports are planned but not available yet. Scanned PDFs with no text layer are rejected with an explanation rather than indexed as blank pages — OCR is not supported today.',
  },
  {
    question: 'How large can my documents be?',
    answer:
      'Up to 25 MB per file, 100 files, and 500 MB in total per account on the free tier. A 200-page PDF is comfortably within that. Longer documents take longer to index; a 50-page file is typically ready in well under a minute.',
  },
  {
    question: 'Does it still hallucinate?',
    answer:
      'It is substantially reduced, not eliminated, and anyone claiming otherwise is overselling. Four things work against it: if no passage clears a relevance threshold, no model call is made at all and Lumora says it could not find the answer; the model is instructed to answer only from the retrieved passages; every citation is validated against what was actually retrieved before it is shown; and the source text is one click away so you can check any claim yourself.',
  },
  {
    question: 'Do you train on my documents?',
    answer:
      'No. Your documents are not used to train our systems or any model provider’s. They are processed to build your private index, and retrieved passages are sent to the model only to answer your own questions.',
  },
  {
    question: 'Which model does Lumora use?',
    answer:
      'Lumora runs on top-tier hosted models and sits behind a provider abstraction, so the model can change without changing how the product behaves. The retrieval layer — which is what actually determines answer quality — is ours.',
  },
  {
    question: 'What exactly happens when I delete a document?',
    answer:
      'The stored file, its extracted text, its passages, and its vectors are removed. It stops influencing answers immediately. Conversations you have already had remain readable, including the snapshot of the passage that was cited at the time, so your history does not silently rewrite itself.',
  },
  {
    question: 'Can I use Lumora with a team?',
    answer:
      'Not yet. Today every account is a private, single-user knowledge base. Shared libraries and workspaces are on the roadmap; we would rather ship single-user properly than ship sharing with unclear permissions.',
  },
];

export function Faq() {
  return (
    <Section id={SECTIONS.faq}>
      <div className="grid gap-12 lg:grid-cols-[0.7fr_1fr] lg:gap-16">
        <SectionHeader
          eyebrow="FAQ"
          title="Questions worth a straight answer"
          className="lg:sticky lg:top-28 lg:self-start"
        />
        <Accordion items={FAQ_ITEMS} />
      </div>
    </Section>
  );
}
