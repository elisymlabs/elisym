import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from './cn';

interface Props {
  content: string;
  className?: string;
}

/**
 * Markdown renderer for untrusted long-form content (e.g. agent policies).
 *
 * Safety:
 * - `skipHtml: true` blocks raw HTML inside markdown (XSS prevention)
 * - Custom anchor handler forces `target="_blank" rel="noopener noreferrer"`
 *   for every link so a malicious href cannot navigate the parent frame
 * - GFM plugin enables tables, strikethrough, task lists, and autolinks
 */
export function Markdown({ content, className }: Props) {
  return (
    <div className={cn('markdown-policy', className)}>
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          a: SafeLink,
          h1: ({ children }) => (
            <h1 className="mt-24 mb-12 text-xl font-semibold text-text first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-20 mb-10 text-lg font-semibold text-text first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-16 mb-8 text-base font-semibold text-text first:mt-0">{children}</h3>
          ),
          p: ({ children }) => (
            <p className="mb-12 text-sm leading-relaxed text-text">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="mb-12 list-disc pl-20 text-sm text-text">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-12 list-decimal pl-20 text-sm text-text">{children}</ol>
          ),
          li: ({ children }) => <li className="mb-4">{children}</li>,
          code: ({ children }) => (
            <code className="rounded-8 bg-surface-2 px-4 py-2 font-mono text-xs text-text">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="mb-12 overflow-x-auto rounded-12 bg-surface-2 p-12 font-mono text-xs text-text">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-12 border-l-2 border-border pl-12 text-sm text-text-2 italic">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-20 border-border" />,
          strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          table: ({ children }) => (
            <div className="mb-12 overflow-x-auto">
              <table className="w-full border-collapse text-sm text-text">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border px-8 py-6 text-left font-semibold">{children}</th>
          ),
          td: ({ children }) => <td className="border-b border-border/40 px-8 py-6">{children}</td>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

interface SafeLinkProps {
  href?: string;
  children?: ReactNode;
}

function SafeLink({ href, children }: SafeLinkProps) {
  if (!href) {
    return <span className="text-accent">{children}</span>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}
