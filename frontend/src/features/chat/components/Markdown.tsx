import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { cn } from '@/lib/utils/cn';

/**
 * A registered subset, not the full library.
 *
 * `highlight.js` bundles ~190 grammars and auto-detection loads all of them —
 * roughly 900KB before compression, for a feature that renders a code block in
 * an answer. These nine cover what a document-grounded assistant actually
 * emits, and an unregistered language degrades to unhighlighted text, which is
 * legible rather than broken.
 */
for (const [name, language] of Object.entries({
  bash,
  css,
  json,
  markdown,
  python,
  sql,
  typescript,
  xml,
  yaml,
})) {
  hljs.registerLanguage(name, language);
}

/** Aliases, so ```` ```js ```` and ```` ```ts ```` do not fall through. */
const ALIASES: Record<string, string> = {
  js: 'typescript',
  jsx: 'typescript',
  ts: 'typescript',
  tsx: 'typescript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  html: 'xml',
  yml: 'yaml',
  py: 'python',
  postgres: 'sql',
  psql: 'sql',
};

interface MarkdownProps {
  children: string;
}

/**
 * Renders an assistant answer.
 *
 * `react-markdown` rather than `dangerouslySetInnerHTML` with a sanitizer:
 * the content is model output built from *document* text, and a document is
 * exactly where an injected `<script>` would come from
 * (docs/05-rag-and-chat.md §4.3 rule 7). `react-markdown` builds React nodes
 * and never parses HTML, so the injection surface does not exist rather than
 * being filtered.
 *
 * Memoized because a thread re-renders on every mutation and re-parsing every
 * prior answer each time is wasted work that grows with the conversation.
 */
export const Markdown = memo(function Markdown({ children }: MarkdownProps) {
  return (
    <div className="space-y-3 text-body-sm leading-relaxed text-primary">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children: content }) => <p className="leading-relaxed">{content}</p>,
          ul: ({ children: content }) => (
            <ul className="list-disc space-y-1 pl-5">{content}</ul>
          ),
          ol: ({ children: content }) => (
            <ol className="list-decimal space-y-1 pl-5">{content}</ol>
          ),
          h1: ({ children: content }) => (
            <h3 className="text-body font-semibold text-primary">{content}</h3>
          ),
          h2: ({ children: content }) => (
            <h3 className="text-body font-semibold text-primary">{content}</h3>
          ),
          h3: ({ children: content }) => (
            <h4 className="text-body-sm font-semibold text-primary">{content}</h4>
          ),
          a: ({ href, children: content }) => (
            <a
              href={href}
              // The link text comes from a document, so it is untrusted:
              // `noopener` denies the target access to `window.opener`.
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline underline-offset-2 hover:no-underline"
            >
              {content}
            </a>
          ),
          blockquote: ({ children: content }) => (
            <blockquote className="border-l-2 border-line pl-3 text-secondary">
              {content}
            </blockquote>
          ),
          table: ({ children: content }) => (
            // Scrolls inside its own container: a wide table must never make
            // the whole thread scroll sideways.
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-caption">{content}</table>
            </div>
          ),
          th: ({ children: content }) => (
            <th className="border border-line px-2 py-1 text-left font-medium">{content}</th>
          ),
          td: ({ children: content }) => (
            <td className="border border-line px-2 py-1 align-top">{content}</td>
          ),
          code: ({ className, children: content }) => {
            const language = /language-(\w+)/.exec(className ?? '')?.[1];

            // No language class means inline code — a fenced block always has
            // one, even when it is `language-text`.
            if (language === undefined) {
              return (
                <code className="rounded-xs bg-inset px-1 py-0.5 font-mono text-[0.85em] text-primary">
                  {content}
                </code>
              );
            }

            return <CodeBlock language={language}>{textOf(content).replace(/\n$/, '')}</CodeBlock>;
          },
          pre: ({ children: content }) => <>{content}</>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});

/**
 * Flattens a React node to its text.
 *
 * `String(node)` would render an element as `[object Object]`, which is what
 * lands in the clipboard and in the highlighter. A fenced block's children are
 * a string or an array of them, so this walks rather than casts.
 */
function textOf(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return '';
}

/**
 * A fenced code block, highlighted and copyable.
 *
 * Highlighting runs in an effect against a ref rather than through
 * `dangerouslySetInnerHTML`: `highlight.js` returns an HTML string, and
 * assigning it directly would reintroduce exactly the injection surface
 * `react-markdown` was chosen to avoid. Setting `innerHTML` on an element
 * whose text content we already control is the narrow, deliberate version of
 * the same operation.
 */
function CodeBlock({ language, children }: { language: string; children: string }) {
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const element = codeRef.current;
    if (element === null) return;

    const resolved = ALIASES[language] ?? language;

    if (hljs.getLanguage(resolved) === undefined) {
      // Unregistered: leave the text as-is. Unhighlighted code is legible;
      // auto-detection would pull in every grammar.
      element.textContent = children;
      return;
    }

    element.innerHTML = hljs.highlight(children, { language: resolved }).value;
  }, [children, language]);

  return (
    <div className="group relative overflow-hidden rounded-md border border-line bg-inset">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="font-mono text-caption text-tertiary">{language}</span>
        <CopyButton text={children} label="Copy code" />
      </div>
      <pre className="overflow-x-auto p-3">
        <code ref={codeRef} className="font-mono text-caption leading-relaxed text-primary">
          {children}
        </code>
      </pre>
    </div>
  );
}

/**
 * Copies text and confirms it happened.
 *
 * The confirmation is the point: a copy button that does nothing visible
 * leaves the user unsure whether it worked, and they press it again. Two
 * seconds is long enough to notice and short enough not to linger.
 */
export function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;

    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  const onCopy = () => {
    void navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      // A denied clipboard permission is not worth an error state; the user
      // can still select the text.
      () => undefined,
    );
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      // `aria-live` on the label, so a screen reader announces the result
      // rather than only the affordance.
      aria-label={copied ? 'Copied' : label}
      className={cn(
        'inline-flex cursor-pointer items-center gap-1 rounded-xs px-1.5 py-0.5 text-caption text-tertiary',
        'transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        className,
      )}
    >
      {copied ? (
        <Check className="size-3.5 text-success" strokeWidth={2} aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
      )}
      <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

export type { ReactNode };
