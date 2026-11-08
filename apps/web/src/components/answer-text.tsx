import * as React from "react";

import { cn } from "@/lib/utils";

const INLINE_PATTERN = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*)/g;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isolateTerms(
  text: string,
  terms: string[],
  keyPrefix: string,
): React.ReactNode[] {
  const usable = terms
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .sort((left, right) => right.length - left.length);
  if (usable.length === 0 || !text) return [text];
  const pattern = new RegExp(`(${usable.map(escapeRegExp).join("|")})`, "gi");
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > lastIndex) nodes.push(text.slice(lastIndex, start));
    nodes.push(
      <bdi key={`${keyPrefix}-bdi-${index++}`} dir="auto">
        {match[0]}
      </bdi>,
    );
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function inlineNodes(
  text: string,
  keyPrefix: string,
  preserveTerms: string[],
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(
        ...isolateTerms(
          text.slice(lastIndex, start),
          preserveTerms,
          `${keyPrefix}-text-${index}`,
        ),
      );
    }
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(
        <strong key={key} className="font-semibold text-foreground">
          {inlineNodes(token.slice(2, -2), `${key}-strong`, preserveTerms)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-secondary/70 px-1 py-0.5 font-mono text-[0.86em]"
        >
          <bdi dir="auto">{token.slice(1, -1)}</bdi>
        </code>,
      );
    } else {
      nodes.push(
        <em key={key}>
          {inlineNodes(token.slice(1, -1), `${key}-em`, preserveTerms)}
        </em>,
      );
    }
    lastIndex = start + token.length;
  }
  if (lastIndex < text.length) {
    nodes.push(
      ...isolateTerms(
        text.slice(lastIndex),
        preserveTerms,
        `${keyPrefix}-tail`,
      ),
    );
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
  direction = "auto",
  preserveTerms = [],
}: {
  text: string;
  className?: string;
  direction?: "ltr" | "rtl" | "auto";
  preserveTerms?: string[];
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
          <li key={`li-${index}`} className="ps-0.5">
            {inlineNodes(
              item,
              `li-${blocks.length}-${index}`,
              preserveTerms,
            )}
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
      <p key={`p-${blocks.length}`}>
        {inlineNodes(trimmed, `p-${blocks.length}`, preserveTerms)}
      </p>,
    );
  }
  flushBullets();

  return (
    <div
      dir={direction}
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
