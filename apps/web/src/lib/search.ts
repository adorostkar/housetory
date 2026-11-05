const QUESTION_PREFIX =
  /^(?:where(?:'s|\s+(?:is|are|can\s+i\s+find|did\s+i\s+(?:put|leave)))?|what(?:'s|\s+is|\s+are)?|which|who|whom|whose|when|why|how(?:\s+many|\s+much)?|do|does|did|is|are|can|could|should|would|will|show|find|list|tell\s+me|give\s+me|locate|search\s+for)\b/i;

const QUESTION_PHRASES = [
  " on loan",
  " loaned",
  " lent out",
  " missing purchase",
  " missing serial",
  " no purchase",
  " without purchase",
  " no receipt",
  " without receipt",
  " purchase information",
  " warranty",
  " how many ",
  " what is ",
  " which items ",
];

/** Conservative client hint; the server remains the source of truth. */
export function looksLikeQuestion(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (value.includes("?")) return true;
  if (QUESTION_PREFIX.test(value)) return true;
  const lowered = ` ${value.toLowerCase()} `;
  return QUESTION_PHRASES.some((phrase) => lowered.includes(phrase));
}
