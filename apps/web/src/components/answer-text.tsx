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

const TABLE_ROW = /^\|(.+)\|$/;
const TABLE_RULE = /^\|(?:\s*:?-{2,}:?\s*\|)+$/;

function tableCells(line: string): string[] {
  return line.slice(1, -1).split("|").map((cell) => cell.trim());
}

/**
 * Safely renders the small, supported prose subset returned by the assistant.
 *
 * Raw HTML and Markdown links are deliberately not interpreted: they remain
 * text. Only paragraphs, headings (#, ##, ###), bullet and numbered lists,
 * pipe tables, bold, italic and inline code are rendered. A table scrolls
 * sideways inside its own box, so it also fits a narrow phone. `dir="auto"`
 * gives Persian/Arabic answers an RTL base direction while preserving
 * embedded LTR names, model numbers and paths.
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
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim());
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;

  const flushList = () => {
    if (!list) return;
    const { ordered, start, items } = list;
    list = null;
    const key = blocks.length;
    const children = items.map((item, index) => (
      <li key={`li-${index}`} className="ps-0.5">
        {inlineNodes(item, `li-${key}-${index}`, preserveTerms)}
      </li>
    ));
    blocks.push(ordered ? (
      <ol key={`ol-${key}`} start={start} className="ms-5 list-decimal space-y-1">{children}</ol>
    ) : (
      <ul key={`ul-${key}`} className="ms-5 list-disc space-y-1">{children}</ul>
    ));
  };

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index] ?? "";
    if (!trimmed) {
      flushList();
      continue;
    }
    const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
    const numbered = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, start: numbered ? Number(numbered[1]) : 1, items: [] };
      list.items.push((numbered ? numbered[2] : bullet?.[1]) ?? "");
      continue;
    }
    flushList();
    const key = blocks.length;
    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      // The answer sits inside a page that has its own headings, so these start lower.
      const Tag = (["h3", "h4", "h5"] as const)[(heading[1]?.length ?? 1) - 1] ?? "h5";
      blocks.push(
        <Tag key={`h-${key}`} className={cn("font-semibold text-foreground", Tag === "h3" && "text-base")}>
          {inlineNodes(heading[2] ?? "", `h-${key}`, preserveTerms)}
        </Tag>,
      );
      continue;
    }
    if (TABLE_ROW.test(trimmed) && TABLE_RULE.test(lines[index + 1] ?? "")) {
      const head = tableCells(trimmed);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && TABLE_ROW.test(lines[index] ?? "")) {
        rows.push(tableCells(lines[index] ?? ""));
        index += 1;
      }
      index -= 1;
      blocks.push(
        <div key={`table-${key}`} role="region" aria-label="Table" tabIndex={0}
          className="max-w-full overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-start text-xs">
            <thead>
              <tr className="bg-secondary/60">
                {head.map((cell, column) => (
                  <th key={column} scope="col" className="px-2.5 py-1.5 text-start font-semibold">
                    {inlineNodes(cell, `th-${key}-${column}`, preserveTerms)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, line) => (
                <tr key={line} className="border-t border-border">
                  {head.map((_, column) => (
                    <td key={column} className="px-2.5 py-1.5 align-top">
                      {inlineNodes(row[column] ?? "", `td-${key}-${line}-${column}`, preserveTerms)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    blocks.push(
      <p key={`p-${key}`}>
        {inlineNodes(trimmed, `p-${key}`, preserveTerms)}
      </p>,
    );
  }
  flushList();

  return (
    <div
      dir={direction}
      data-testid="answer-text"
      className={cn(
        "space-y-2 text-start text-sm leading-[1.8] text-foreground/90",
        className,
      )}
    >
      {blocks}
    </div>
  );
}
