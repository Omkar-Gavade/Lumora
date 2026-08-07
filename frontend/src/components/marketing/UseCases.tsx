import { SECTIONS } from '@/app/router/routes';
import { Section } from '@/components/common/Section';
import { SectionHeader } from '@/components/common/SectionHeader';
import { Card } from '@/components/ui/Card';

/**
 * Each case is anchored by a real question someone would actually type. Generic
 * persona cards ("For teams!") say nothing; a specific question lets a reader
 * recognise their own problem in two seconds.
 */
const USE_CASES = [
  {
    audience: 'Contracts and policy',
    body: 'Load agreements, statements of work, and internal policies, then ask across all of them at once instead of opening each file.',
    questions: [
      'Which of these vendors can raise prices mid-term?',
      'Do any of these agreements auto-renew?',
    ],
  },
  {
    audience: 'Research and study',
    body: 'Build a library of papers and reports and ask what the literature actually says, with each claim traced to the paper it came from.',
    questions: [
      'Which of these studies used a control group?',
      'Summarise the disagreement about sample size.',
    ],
  },
  {
    audience: 'Handbooks and SOPs',
    body: 'Turn onboarding docs, runbooks, and internal wikis into something answerable, so the same five questions stop arriving in your inbox.',
    questions: [
      'How much notice is required for unpaid leave?',
      'What is the escalation path for a Sev-1?',
    ],
  },
];

export function UseCases() {
  return (
    <Section id={SECTIONS.useCases} tone="subtle" bordered>
      <SectionHeader
        eyebrow="Use cases"
        title="Where a grounded answer is worth more than a fast one"
        description="Lumora is most useful when being wrong has a cost — and when you need to show your work."
      />

      <div className="mt-14 grid gap-4 md:grid-cols-3">
        {USE_CASES.map((useCase) => (
          <Card key={useCase.audience} className="flex flex-col p-7">
            <h3 className="text-h3">{useCase.audience}</h3>
            <p className="mt-2.5 text-body-sm text-secondary text-pretty">{useCase.body}</p>

            <ul className="mt-6 space-y-2 border-t border-line pt-5">
              {useCase.questions.map((question) => (
                <li
                  key={question}
                  className="rounded-md bg-inset px-3 py-2 text-caption text-secondary"
                >
                  &ldquo;{question}&rdquo;
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </Section>
  );
}
