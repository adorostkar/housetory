"""Deterministic query normalisation shared by search, assistant and matching.

Normalisation is only used for comparison. Original item names, brand/model
strings, identifiers and the user's wording are always preserved for output and
for provider prompts. In particular, non-Latin scripts are never stripped.
"""

from __future__ import annotations

import re
import unicodedata

# Arabic/Persian letter variants that are commonly typed interchangeably. The
# mapping is deliberately limited to letters and presentation variants; it does
# not translate words or remove scripts.
_LETTER_VARIANTS = str.maketrans(
    {
        "ي": "ی",
        "ى": "ی",
        "ئ": "ی",
        "ك": "ک",
        "ڪ": "ک",
        "ة": "ه",
        "ۀ": "ه",
        "أ": "ا",
        "إ": "ا",
        "آ": "ا",
        "ٱ": "ا",
        "ؤ": "و",
        "ﻻ": "لا",
        "ﻷ": "لا",
        "ﻹ": "لا",
        "ﻵ": "لا",
    }
)

_DIGIT_VARIANTS = str.maketrans(
    {
        **{chr(0x0660 + index): str(index) for index in range(10)},
        **{chr(0x06F0 + index): str(index) for index in range(10)},
    }
)

_INVISIBLE = re.compile(
    "[\u200b-\u200f\u202a-\u202e\u2060\ufeff\u00ad\u034f\u061c\u180e]"
)
_ARABIC_DIACRITICS = re.compile("[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]")
_WHITESPACE = re.compile(r"\s+")

# English question words/phrases kept for compatibility with existing English
# queries. Non-English questions are detected by their own question marks and
# question/pronoun vocabulary, or deliberately escalated on submit.
QUESTION_PREFIX = re.compile(
    r"^(?:where(?:'s|\s+(?:is|are|can\s+i\s+find|did\s+i\s+(?:put|leave)|"
    r"should\s+i\s+look\s+for))?|what(?:'s|\s+is|\s+are)?|which|who|whom|whose|"
    r"when|why|how(?:\s+many|\s+much)?|do|does|did|is|are|can|could|should|would|"
    r"will|show\s+me|find|list|tell\s+me|give\s+me|locate|search\s+for)\b",
    re.IGNORECASE,
)

_QUESTION_WORDS = {
    # Persian
    "کجا",
    "کجاست",
    "کجای",
    "کجاست؟",
    "کدام",
    "چی",
    "چه",
    "چرا",
    "چطور",
    "چگونه",
    "آیا",
    "ایا",
    "کی",
    "چند",
    "چقدر",
    "کیه",
    "کدوم",
    # Arabic
    "أين",
    "اين",
    "وين",
    "ماذا",
    "ما",
    "هل",
    "كم",
    "متى",
    "لماذا",
    "كيف",
    "أي",
    "اي",
    "من",
    "عند",
    # English (also covered by QUESTION_PREFIX)
    "where",
    "what",
    "which",
    "who",
    "when",
    "why",
    "how",
    "did",
    "does",
    "do",
    "is",
    "are",
}

_QUESTION_MARKS = "?\u061f\uff1f"
_QUESTION_PHRASES = (
    " on loan",
    " loaned",
    " lent out",
    " missing purchase",
    " no purchase",
    " without purchase",
    " no receipt",
    " without receipt",
    " purchase information",
    " warranty",
    " how many ",
    " what is ",
    " which items ",
    # Persian phrases commonly used in real questions; these are intent
    # signals, not a translation dictionary.
    "قرض",
    "امانت",
    "کجا",
    "چند",
    "کدام",
    "مال کی",
    "کی داره",
    "کی دارد",
    # Arabic
    "قرض",
    "أمانة",
    "امانة",
    "أين",
    "اين",
    "كم",
    "متى",
    "ما هو",
    "ما هي",
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
    # Persian/Arabic leading question and possessive forms. These remove only
    # function words; item names stay intact.
    r"^(?:کجاست|کجا|کجای|کدام|چه|چی|آیا|ایا|چند|چقدر)\s+",
    r"^(?:أين|اين|وين|هل|ماذا|كم|متى|لماذا|كيف|أي|اي)\s+",
    r"^(?:مال|برای)\s+",
)

TRAILING_PATTERNS = (
    r"\s+(?:do\s+i\s+own|do\s+i\s+have|are\s+there|have\s+i\s+got)\s*[?.!]*$",
    r"(?:^|\s+)(?:currently\s+)?(?:on\s+loan|loaned\s+out|lent\s+out)\s*[?.!]*$",
    # Persian/Arabic trailing question/possessive forms.
    r"\s+(?:کجاست|کجاست؟|کجا|هست|است|دارم|داریم|داری|دارد)\s*[؟?.!]*$",
    r"\s+(?:أين|اين|وين|هل|موجود)\s*[؟?.!]*$",
)

# Function words that can be dropped when deriving a subject for a direct
# lookup. They are only matched as whole tokens, so a legitimate item named
# "Drill" is unaffected.
_SUBJECT_STOPWORDS = {
    "my",
    "our",
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "where",
    "what",
    "which",
    "who",
    "whom",
    "whose",
    "when",
    "why",
    "how",
    "many",
    "much",
    "do",
    "does",
    "did",
    "can",
    "could",
    "should",
    "would",
    "will",
    "show",
    "find",
    "list",
    "tell",
    "give",
    "locate",
    "search",
    "for",
    "me",
    "about",
    "related",
    "to",
    "it",
    "them",
    "mine",
    "من",
    "ما",
    "مال",
    "برای",
    "که",
    "را",
    "این",
    "آن",
    "کجاست",
    "کجا",
    "کجای",
    "کدام",
    "چی",
    "چه",
    "چرا",
    "چطور",
    "چگونه",
    "آیا",
    "ایا",
    "کی",
    "چند",
    "چقدر",
    "هست",
    "است",
    "بود",
    "دارم",
    "داریم",
    "داری",
    "دارد",
    "أين",
    "اين",
    "وين",
    "هل",
    "ماذا",
    "كم",
    "متى",
    "لماذا",
    "كيف",
    "أي",
    "اي",
    "عند",
    "في",
    "على",
}


def normalize_text(text: str) -> str:
    """Unicode-normalise for comparison while preserving the script.

    NFKC safely folds presentation forms; letter variants are mapped so Persian
    and Arabic spellings meet, invisible joiners/diacritics are removed, and
    Arabic-Indic digits become ASCII. Original strings are never mutated in
    place and should still be used for display and identifiers.
    """
    if not text:
        return ""
    value = unicodedata.normalize("NFKC", text)
    value = value.translate(_LETTER_VARIANTS)
    value = value.translate(_DIGIT_VARIANTS)
    value = _INVISIBLE.sub("", value)
    value = value.replace("\u200c", "").replace("\u200d", "")
    value = _ARABIC_DIACRITICS.sub("", value)
    value = value.replace("\u0640", "")  # tatweel
    value = _WHITESPACE.sub(" ", value)
    return value.strip()


def normalize_for_match(text: str) -> str:
    return normalize_text(text).casefold()


def contains_non_latin(text: str) -> bool:
    return any(character.isalpha() and ord(character) > 127 for character in text)


def normalize_label(text: str) -> str:
    """Normalise a name/label for identity comparison, not display."""
    value = normalize_for_match(text)
    value = re.sub(r"[^\w]+", " ", value, flags=re.UNICODE)
    return re.sub(r"\s+", " ", value).strip()


def item_words(text: str) -> list[str]:
    """Unicode-aware subject tokens, with function words removed."""
    normalized = normalize_for_match(text)
    tokens = [
        token
        for token in re.findall(r"[\w]+", normalized, flags=re.UNICODE)
        if token and token not in _SUBJECT_STOPWORDS
    ]
    return tokens


def text_contains_term(haystack: str, needle: str) -> bool:
    """Normalised substring/token containment used by Python fallbacks."""
    if not haystack or not needle:
        return False
    normalized_haystack = normalize_for_match(haystack)
    normalized_needle = normalize_for_match(needle)
    if not normalized_needle:
        return False
    if normalized_needle in normalized_haystack:
        return True
    tokens = item_words(needle)
    if not tokens:
        return False
    return all(token in normalized_haystack for token in tokens)


def looks_like_question(text: str) -> bool:
    cleaned = normalize_text(text)
    if not cleaned:
        return False
    if any(mark in cleaned for mark in _QUESTION_MARKS):
        return True
    lowered = f" {cleaned.casefold()} "
    if QUESTION_PREFIX.search(cleaned):
        return True
    if any(phrase.casefold() in lowered for phrase in _QUESTION_PHRASES):
        return True
    tokens = {token.casefold() for token in re.findall(r"[\w]+", cleaned, flags=re.UNICODE)}
    # No blanket non-Latin question rule: a multi-word recorded name should
    # still receive a cheap confident direct match. A plain multilingual
    # question without a recognised question word is escalated on submit when
    # direct lookup does not confidently match.
    return bool(tokens & {word.casefold() for word in _QUESTION_WORDS})


def clean_subject(text: str) -> str:
    # A ZWNJ is a display half-space. For subject derivation it is a word
    # boundary, so "دریل‌من" becomes two tokens and the possessive can be
    # removed without losing the item word.
    subject_source = text.replace("\u200c", " ").replace("\u200d", " ")
    cleaned = re.sub(r"\s+", " ", normalize_text(subject_source).strip())
    for _ in range(4):
        before = cleaned
        for pattern in (*LEADING_PATTERNS, *TRAILING_PATTERNS):
            updated = re.sub(pattern, "", cleaned, flags=re.IGNORECASE)
            if updated != cleaned:
                cleaned = updated.strip()
                break
        if cleaned == before:
            break
    cleaned = cleaned.strip(" ?.!,\u061f\uff1f\u3002")
    filtered: list[str] = []
    for token in cleaned.split():
        core = token.strip(" ?.!,\u061f\uff1f\u3002،؛:()[]{}")
        if not core:
            continue
        if core.casefold() in _SUBJECT_STOPWORDS:
            continue
        if not any(character.isalnum() for character in core):
            continue
        filtered.append(core)
    value = " ".join(filtered).strip()
    return re.sub(r"\s+", " ", value).strip(" ?.!,\u061f\uff1f\u3002")


def _singular(token: str) -> str:
    if len(token) <= 3 or contains_non_latin(token):
        return token
    lowered = token.lower()
    if lowered.endswith("ies") and len(token) > 3:
        return f"{token[:-3]}y"
    if lowered.endswith(("ches", "shes", "sses", "xes", "zes")) and len(token) > 3:
        return token[:-2]
    if lowered.endswith("s") and not lowered.endswith("ss") and len(token) > 2:
        return token[:-1]
    return token


def search_term_variants(term: str) -> list[str]:
    """Return matching variants without translating or stripping scripts.

    The original query and the normalised (variant-folded) form are both
    returned. ASCII plural/singular variants are retained for existing English
    matching behaviour. Non-Latin terms are never singularised or transliterated.
    """
    original = term.strip()
    values = [original]
    normalized = normalize_text(original)
    if normalized and normalized.casefold() != original.casefold():
        values.append(normalized)
    words = normalized.split()
    if words:
        last = words[-1]
        singular = _singular(last)
        if singular != last:
            values.append(" ".join([*words[:-1], singular]))
    return list(dict.fromkeys(value for value in values if value))
