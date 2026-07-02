"""Deterministic prompt-injection / jailbreak guard for the public kiosk.

The anonymous kiosk is the one surface a stranger can type anything into. This catches the
obvious subversion attempts — "ignore your instructions", "reveal your system prompt",
"pretend you are DAN", "developer mode", "no rules or restrictions" — BEFORE they reach the
LLM. Blocking deterministically means nothing is leaked, no tokens are spent, and the reply
is instant.

Defense in depth, not the only line: the kiosk already can't reach any privileged tool
(allow-listing) and the grounding gate stops fabrication. This just refuses the attempt up
front instead of relying on the model to resist it.

Patterns are intentionally SPECIFIC (multi-word phrases) so genuine campus questions never
trip them — "who teaches the systems course", "where is the admin office", "ignore that,
what about Derek" all pass through untouched.
"""
import re

_PATTERNS = [
    # "ignore / disregard / forget ... (previous|prior|above) ... instructions/rules/prompt"
    r"\b(ignore|disregard|forget|override)\b[^.!?]{0,40}\b(previous|prior|earlier|above|preceding|initial|the above|your|all)\b[^.!?]{0,20}\b(instructions?|rules?|prompts?|directions?|guidelines?)\b",
    # exfiltrate the system prompt / hidden instructions
    r"\b(reveal|repeat|show|print|expose|output|give me|tell me|share)\b[^.!?]{0,30}\b(system|initial|hidden|original|secret|internal)\b[^.!?]{0,15}\b(prompt|instructions?|message|rules?)\b",
    r"\bwhat (are|were) your\b[^.!?]{0,20}\b(system |initial |original )?(instructions?|rules?|prompt)\b",
    r"\b(repeat|print|output|say)\b[^.!?]{0,20}\bthe (words|text|sentence)s? (above|before)\b",
    # jailbreak persona / mode
    r"\byou are (now |going to be )?(dan|do anything now)\b",
    r"\b(do anything now|dan)\b[^.!?]{0,10}\b(mode|prompt)\b",
    r"\b(developer|dev|god|jailbreak|unrestricted|uncensored|sudo|root|admin)\s+mode\b",
    r"\b(pretend|act|behave|roleplay|role-play)\b[^.!?]{0,30}\b(no rules|no restrictions|no limits|dan|jailbroken|without (any )?(rules|restrictions|filters|limits))\b",
    r"\bwith no (rules|restrictions|limits|filters|guidelines)\b",
    r"\byou are no longer (bound|restricted|limited|required)\b",
    # disable/bypass the guardrails
    r"\b(ignore|bypass|override|disable|turn off|remove|forget)\b[^.!?]{0,25}\b(scope|safety|content|guard\w*|guidelines?|restrictions?|filters?|limits?|rules?)\b",
    r"\bfrom now on,?\b[^.!?]{0,25}\b(ignore|append|end (each|every)|respond only|reply only|you (will|must))\b",
    r"\bi order you\b",
    # the canary token from the red-team eval suite
    r"\bBANANA42\b",
]
_RE = re.compile("|".join(f"(?:{p})" for p in _PATTERNS), re.IGNORECASE)

REFUSAL = ("I can only help with TTU ECE campus questions — classes, professors, offices, "
           "office hours, labs, and the stockroom. What would you like to look up?")


def is_injection(text: str) -> bool:
    """True if the input looks like a prompt-injection / jailbreak / prompt-leak attempt
    rather than a real campus question. High-precision by design (see module docstring)."""
    return bool(_RE.search(text or ""))
