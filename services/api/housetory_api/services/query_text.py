"""Small deterministic query-normalisation helpers shared by search and assistant."""

import re

QUESTION_PREFIX = re.compile(
    r"^(?:where(?:'s|\s+(?:is|are|can\s+i\s+find|did\s+i\s+(?:put|leave)|"
    r"should\s+i\s+look\s+for))?|what(?:'s|\s+is|\s+are)?|which|who|whom|whose|"
    r"when|why|how(?:\s+many|\s+much)?|do|does|did|is|are|can|could|should|would|"
    r"will|show\s+me|find|list|tell\s+me|give\s+me|locate|search\s+for)\b",
    re.IGNORECASE,
)

QUESTION_PHRASES = (
    " on loan",
    " loaned",
    " lent out",
    " missing purchase",
    " missing serial",
    " no purchase",
    " no receipt",
    " purchase information",
    " warranty",
    " how many ",
    " what is ",
    " which items ",
)

LEADING_PATTERNS = (
    r"^where\s+(?:is|are|can\s+i\s+find|did\s+i\s+(?:put|leave)|"
    r"should\s+i\s+look\s+for)\s+",
    r"^where(?:'s)\s+",
    r"^what\s+is\s+the\s+location\s+of\s+",
    r"^what(?:'s|\s+is)\s+",
    r"^show\s+me\s+",
    r"^find(?:\s+me)?\s+",
    r"^list\s+",
    r"^tell\s+me\s+about\s+",
    r"^how\s+many\s+",
    r"^how\s+much\s+",
    r"^do\s+i\s+(?:own|have)\s+",
    r"^which\s+items?\s+",
    r"^what\s+items?\s+",
    r"^locate\s+",
    r"^search\s+for\s+",
    r"^(?:is|are|was|were)\s+",
)

TRAILING_PATTERNS = (
    r"\s+(?:do\s+i\s+own|do\s+i\s+have|are\s+there|have\s+i\s+got)\s*[?.!]*$",
    r"(?:^|\s+)(?:currently\s+)?(?:on\s+loan|loaned\s+out|lent\s+out)\s*[?.!]*$",
)


def looks_like_question(text: str) -> bool:
    cleaned = text.strip()
    if not cleaned:
        return False
    if "?" in cleaned:
        return True
    lowered = f" {cleaned.lower()} "
    return bool(QUESTION_PREFIX.search(cleaned)) or any(
        phrase in lowered for phrase in QUESTION_PHRASES
    )


def clean_subject(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text.strip())
    for _ in range(3):
        for pattern in (*LEADING_PATTERNS, *TRAILING_PATTERNS):
            updated = re.sub(pattern, "", cleaned, flags=re.IGNORECASE)
            if updated != cleaned:
                cleaned = updated.strip()
                break
    cleaned = re.sub(
        r"^(?:my|our|the|a|an)\s+",
        "",
        cleaned.strip(" ?.!,"),
        flags=re.IGNORECASE,
    )
    return re.sub(r"\s+", " ", cleaned).strip(" ?.!,")


def search_term_variants(term: str) -> list[str]:
    """Return the phrase plus a conservative singular variant for item names."""
    values = [term.strip()]
    words = values[0].split()
    if words:
        last = words[-1]
        lowered = last.lower()
        singular = last
        if lowered.endswith("ies") and len(last) > 3:
            singular = f"{last[:-3]}y"
        elif lowered.endswith(("ches", "shes", "sses", "xes", "zes")) and len(last) > 3:
            singular = last[:-2]
        elif lowered.endswith("s") and not lowered.endswith("ss") and len(last) > 2:
            singular = last[:-1]
        if singular != last:
            values.append(" ".join([*words[:-1], singular]))
    return list(dict.fromkeys(value for value in values if value))
