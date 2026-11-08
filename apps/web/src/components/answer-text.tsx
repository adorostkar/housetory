import * as React from "react";

import { cn } from "@/lib/utils";

const INLINE_PATTERN = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*)/g;

function inlineNodes(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start));
    }
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(
        <strong key={key} dir="auto" className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <code
          key={key}
          dir="auto"
          className="rounded bg-secondary/70 px-1 py-0.5 font-mono text-[0.86em]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(
        <em key={key} dir="auto">
          {token.slice(1, -1)}
        </em>,
      );
    }
    lastIndex = start + token.length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

/**
 * Safely renders the small, supported prose subset returned by the assistant.
 *
 * Raw HTML and Markdown links are deliberately not interpreted: they remain
 * text. Only paragraphs, simple bullet lists, bold, italic and inline code are
 * rendered. `dir="auto"` gives Persian/Arabic answers an RTL base direction
 * while preserving embedded LTR names, model numbers and paths.
 */
export function AnswerText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];

  const flushBullets = () => {
    if (bullets.length === 0) return;
    const items = bullets;
    bullets = [];
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="ms-5 list-disc space-y-1">
        {items.map((item, index) => (
          <li key={`li-${index}`} dir="auto" className="ps-0.5">
            {inlineNodes(item, `li-${blocks.length}-${index}`)}
          </li>
        ))}
      </ul>,
    );
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushBullets();
      continue;
    }
    const bullet = trimmed.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      bullets.push(bullet[1] ?? "");
      continue;
    }
    flushBullets();
    blocks.push(
      <p key={`p-${blocks.length}`} dir="auto">
        {inlineNodes(trimmed, `p-${blocks.length}`)}
      </p>,
    );
  }
  flushBullets();

  return (
    <div
      dir="auto"
      data-testid="answer-text"
      className={cn(
        "space-y-2 text-start text-[0.9rem] leading-[1.8] text-foreground/90",
        className,
      )}
    >
      {blocks}
    </div>
  );
}
