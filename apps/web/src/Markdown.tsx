import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { defaultUrlTransform, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Keep local/fragment links, and only allow explicitly safe absolute protocols.
 * react-markdown already filters unsafe URLs; the explicit policy here also
 * documents and tests the protocols Neocode permits.
 */
export function safeMarkdownUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";

  // A colon before a path/query/fragment separator denotes a URI scheme.
  const scheme = trimmed.match(/^([a-z][a-z\d+.-]*):/i);
  if (scheme && !SAFE_PROTOCOLS.has(`${scheme[1]!.toLowerCase()}:`)) return "";

  return defaultUrlTransform(trimmed);
}

function SafeLink({ href, children, node: _node, ...props }: ComponentPropsWithoutRef<"a"> & ExtraProps) {
  if (!href) return <span className="unsafe-link">{children}</span>;
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="message-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeMarkdownUrl}
        components={{
          a: SafeLink,
          // Transcript images can leak information to a remote host. Keep the
          // useful label without making a request from the local UI.
          img: ({ alt }) => <span className="markdown-image">[image: {alt || "attachment"}]</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
