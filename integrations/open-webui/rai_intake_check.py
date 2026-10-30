"""
title: RA(I) Intake Check
author: RA(I) / Security Lab SE
author_url: https://withrai.xyz
funding_url: https://withrai.xyz/own
version: 0.1.1
license: MIT
required_open_webui_version: 0.12.0
description: Runs entirely on your machine. Sends nothing to RA(I). Checks content entering your chat (your messages, uploaded documents, retrieved knowledge) for hidden instructions and exposed secrets, and shows a signal you act on. Signal, not verdict.
"""

# RA(I) Intake Check, Open WebUI Filter Function (OL-660, spec rai/docs/37).
#
# What it is: a pattern + heuristic layer (RAI P0 floor + L2 hidden-channel
# checks) that runs on text BEFORE it reaches the model context. It is a
# SIGNAL layer: it catches the common, cheap, templated injections and the
# obvious exposed secrets. A determined attacker can evade it. It is not a
# guarantee and never claims to be one.
#
# Data principle (Constitution Rule 4): no network. No imports of requests,
# httpx, urllib, socket, aiohttp. Nothing leaves this process. The optional
# local log is a counter file on your disk, off by default.
#
# Placeholders left in the context under action=drop are deliberately bland and
# carry no threat labels: a model that reads "security alert" in its input may
# invent a verdict dialog of its own, which the user could mistake for RA(I)'s.
# The labels live only in the status line the human sees.
#
# Hooks (Open WebUI 0.12.x):
#   inlet(body)   : before retrieval. Scans the latest user message and any
#                   uploaded file text already present in the body.
#   request(body) : after retrieval, before the model call. Scans the system
#                   message, which is where Open WebUI injects retrieved
#                   knowledge chunks and uploaded-file context.
#   outlet(body)  : on the model reply. Scans for exposed-secret / exfil
#                   markers only (L-2). Never modifies the reply.
#
# The P0 pattern block below is GENERATED from packages/core/rai-scan-p0.ts
# by scripts/build-open-webui-function.py. Do not hand-edit it.

import base64
import json
import logging
import os
import re
import time
from typing import Any, Callable, Dict, List, Optional

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# P0 pattern floor (generated)
# ---------------------------------------------------------------------------
# __P0_PATTERNS_BEGIN__
P0_PATTERNS_JSON = "[{\"source\":\"\\\\/Users\\\\/[a-zA-Z]+\\\\/|\\\\/mnt\\\\/|\\\\/home\\\\/[a-zA-Z]+\\\\/nanoclaw\",\"flags\":\"i\",\"label\":\"Mount path reference\",\"layer\":\"L-2\",\"severity\":\"critical\",\"signal\":\"Host filesystem path detected in payload\"},{\"source\":\"REGISTRY\\\\.md|00-WAKE\\\\.md|decision-log|open-loops\",\"flags\":\"i\",\"label\":\"Context file reference\",\"layer\":\"L-2\",\"severity\":\"critical\",\"signal\":\"No5 context file name detected in payload\"},{\"source\":\"(?:send|forward|email|post|upload|exfil)[^\\\\n]{0,40}(?:to|at)\\\\s+[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\\\.[a-z]{2,}\",\"flags\":\"i\",\"label\":\"Credential / data exfiltration attempt\",\"layer\":\"L-2\",\"severity\":\"critical\",\"signal\":\"Instruction to send data to external address\"},{\"source\":\"(?:modify|edit|update|delete|overwrite|write to|append to)\\\\s+(?:the\\\\s+)?(?:context|registry|wake|decision.log|open.loops|CLAUDE\\\\.md)\",\"flags\":\"i\",\"label\":\"Context file manipulation\",\"layer\":\"L-2\",\"severity\":\"critical\",\"signal\":\"Instruction to modify No5 context files\"},{\"source\":\"use\\\\s+(?:the\\\\s+)?(?:mcp\\\\s+)?tool|call\\\\s+(?:the\\\\s+)?function|execute\\\\s+(?:the\\\\s+)?(?:tool|command|function)\",\"flags\":\"i\",\"label\":\"MCP tool call injection\",\"layer\":\"L-2\",\"severity\":\"high\",\"signal\":\"Instruction to invoke tool/function detected in payload\"},{\"source\":\"you\\\\s+are\\\\s+now\\\\s+(?!no5|an?\\\\s+AI|an?\\\\s+assistant)[a-zA-Z]\",\"flags\":\"i\",\"label\":\"Persona replacement\",\"layer\":\"L-1\",\"severity\":\"critical\",\"signal\":\"Attempt to replace agent persona\"},{\"source\":\"forget\\\\s+(?:that\\\\s+)?you\\\\s+are|your\\\\s+new\\\\s+(?:identity|persona|role|name)\\\\s+is\",\"flags\":\"i\",\"label\":\"Persona replacement\",\"layer\":\"L-1\",\"severity\":\"critical\",\"signal\":\"Attempt to overwrite agent identity\"},{\"source\":\"(?:your\\\\s+)?(?:new|updated)\\\\s+(?:system\\\\s+)?(?:instructions?|prompt|rules?|directives?)\\\\s+(?:are|is):\",\"flags\":\"i\",\"label\":\"System prompt injection\",\"layer\":\"L-1\",\"severity\":\"critical\",\"signal\":\"Attempt to inject new system-level instructions\"},{\"source\":\"ignore\\\\s+(?:your\\\\s+)?(?:previous\\\\s+)?(?:training|guidelines|rules|instructions|constraints)\",\"flags\":\"i\",\"label\":\"Training override attempt\",\"layer\":\"L-1\",\"severity\":\"high\",\"signal\":\"Instruction to override model training or guidelines\"},{\"source\":\"from\\\\s+now\\\\s+on[,\\\\s]+(?:always|never)\\\\s+|always\\\\s+respond\\\\s+by\\\\s+|never\\\\s+(?:mention|refer|say|tell)\",\"flags\":\"i\",\"label\":\"Behavioral drift injection\",\"layer\":\"L-1\",\"severity\":\"high\",\"signal\":\"Attempt to modify persistent agent behavior\"},{\"source\":\"ignore\\\\s+(?:all\\\\s+)?(?:previous|prior|earlier|above)\\\\s+instructions?\",\"flags\":\"i\",\"label\":\"Direct prompt injection\",\"layer\":\"L0\",\"severity\":\"critical\",\"signal\":\"\\\"Ignore previous instructions\\\" pattern\"},{\"source\":\"disregard\\\\s+(?:all\\\\s+)?(?:previous|prior|your)\\\\s+|override\\\\s+(?:your\\\\s+)?(?:instructions?|programming|rules)\",\"flags\":\"i\",\"label\":\"Direct prompt injection\",\"layer\":\"L0\",\"severity\":\"critical\",\"signal\":\"Disregard/override instruction pattern\"},{\"source\":\"\\\\bDAN\\\\b|developer\\\\s+mode|jailbreak|unrestricted\\\\s+mode|pretend\\\\s+you\\\\s+have\\\\s+no\\\\s+rules|no\\\\s+restrictions\\\\s+mode\",\"flags\":\"i\",\"label\":\"Jailbreak attempt\",\"layer\":\"L0\",\"severity\":\"critical\",\"signal\":\"Known jailbreak pattern detected\"},{\"source\":\"act\\\\s+as\\\\s+(?:if\\\\s+you\\\\s+(?:are|were)\\\\s+)?(?:an?\\\\s+)?(?:unrestricted|unfiltered|uncensored|evil|malicious)\",\"flags\":\"i\",\"label\":\"Jailbreak attempt\",\"layer\":\"L0\",\"severity\":\"critical\",\"signal\":\"Request to act as unrestricted/unfiltered model\"},{\"source\":\"<<\\\\s*system[_\\\\s-]?override\\\\s*>>|\\\\[\\\\[\\\\s*system[_\\\\s-]?override\\\\s*\\\\]\\\\]|\\\\[\\\\s*system[_\\\\s-]?override\\\\s*\\\\]\",\"flags\":\"i\",\"label\":\"Direct prompt injection\",\"layer\":\"L0\",\"severity\":\"critical\",\"signal\":\"System-override token detected (<<SYSTEM_OVERRIDE>>-style bracket)\"},{\"source\":\"(?:previous|prior|earlier|original)\\\\s+instructions?\\\\s+(?:are|is|have\\\\s+been|were)\\\\s+(?:deprecated|superseded|invalid|cancelled|revoked|outdated|obsolete|replaced)\",\"flags\":\"i\",\"label\":\"Direct prompt injection\",\"layer\":\"L0\",\"severity\":\"critical\",\"signal\":\"Prior-instructions-deprecated injection pattern\"},{\"source\":\"(?:do\\\\s+not|don'?t|never)\\\\s+(?:include|mention|reveal|log|record|disclose|show)[^.]{0,40}?(?:audit\\\\s*log|in\\\\s+(?:your\\\\s+)?(?:response|reply|output)|notice)\",\"flags\":\"i\",\"label\":\"Audit-log evasion\",\"layer\":\"L0\",\"severity\":\"critical\",\"signal\":\"Instruction to suppress this notice from response/log\"},{\"source\":\"(?:schema|protocol|system|policy|security|api)\\\\s+(?:migration|update|upgrade|patch|refresh|reset)\\\\b[^.]{0,80}?(?:deprecat|overrid|ignor|supersed|invalid|new\\\\s+instruction)\",\"flags\":\"i\",\"label\":\"Direct prompt injection\",\"layer\":\"L0\",\"severity\":\"critical\",\"signal\":\"Pretextual update (schema/protocol/policy) used as override justification\"},{\"source\":\"(?:url[-\\\\s]?encode|encode\\\\s+(?:the\\\\s+)?(?:result|output|data|response|answer|query))\\\\s+(?:as\\\\s+(?:an?\\\\s+)?url|in\\\\s+(?:an?\\\\s+)?url|into\\\\s+(?:an?\\\\s+)?url)\",\"flags\":\"i\",\"label\":\"Data exfiltration via URL\",\"layer\":\"L0\",\"severity\":\"critical\",\"signal\":\"Instruction to exfiltrate data via URL-encoded payload\"},{\"source\":\"ignore\\\\s+(?:all\\\\s+)?(?:scan|firewall|rai|security|inspection)\\\\s+(?:instructions?|rules?|procedures?|settings?|checks?)\",\"flags\":\"i\",\"label\":\"Scan-bypass injection\",\"layer\":\"L-1\",\"severity\":\"critical\",\"signal\":\"Instruction to ignore scan/firewall rules embedded in payload\"},{\"source\":\"(?:pre-?verified|already\\\\s+verified|security\\\\s+team\\\\s+(?:approved|certified|verified|pre-?cleared)|output\\\\s+(?:only\\\\s+)?clean|return\\\\s+(?:verdict\\\\s+)?(?::|=)?\\\\s*clean)\",\"flags\":\"i\",\"label\":\"Scan-bypass injection\",\"layer\":\"L-1\",\"severity\":\"critical\",\"signal\":\"Claim of pre-verification or instruction to return CLEAN verdict\"},{\"source\":\"(?:important\\\\s+security\\\\s+update|maintenance\\\\s+window|policy\\\\s+override\\\\s+active|system\\\\s+administrator)[^.]{0,80}(?:ignore|bypass|override|skip|disable)\",\"flags\":\"i\",\"label\":\"Authority-framing injection\",\"layer\":\"L-1\",\"severity\":\"critical\",\"signal\":\"Authority-framing language used to justify bypassing scan instructions\"},{\"source\":\"ignoriere\\\\s+(?:alle?\\\\s+)?(?:vorherigen?|fr\\u00fcheren?|bisherigen?)?\\\\s*(?:anweisungen?|regeln?|instruktionen?|einschr\\u00e4nkungen?)|vergiss\\\\s+(?:alle?\\\\s+)?(?:regeln?|anweisungen?|instruktionen?)\",\"flags\":\"i\",\"label\":\"Multilingual prompt injection (DE)\",\"layer\":\"L-1\",\"severity\":\"critical\",\"signal\":\"German-language instruction override pattern detected\"},{\"source\":\"du\\\\s+bist\\\\s+jetzt\\\\s+(?:ein|eine|im|in)\\\\s+(?:neuen?|anderen?|freien?|uneingeschr\\u00e4nkten?)|deine\\\\s+neue\\\\s+(?:identit\\u00e4t|rolle|persona|aufgabe)\\\\s+ist\",\"flags\":\"i\",\"label\":\"Multilingual persona replacement (DE)\",\"layer\":\"L-1\",\"severity\":\"critical\",\"signal\":\"German-language persona replacement pattern detected\"},{\"source\":\"\\\\[INST\\\\]|\\\\[\\\\/INST\\\\]|<\\\\|im_start\\\\|>|<\\\\|im_end\\\\|>|<<SYS>>|<\\\\/SYS>>|\\\\[SYSTEM\\\\]|\\\\[USER\\\\]|\\\\[ASSISTANT\\\\]\",\"flags\":\"\",\"label\":\"Model token injection\",\"layer\":\"L0\",\"severity\":\"critical\",\"signal\":\"LLM prompt template token detected in payload (Llama/Mistral/ChatML format)\"},{\"source\":\"<!--[\\\\s\\\\S]{0,200}(?:ignore|override|bypass|inject|system|instruction)[\\\\s\\\\S]{0,200}-->\",\"flags\":\"i\",\"label\":\"HTML comment instruction hiding\",\"layer\":\"L0\",\"severity\":\"high\",\"signal\":\"Instructions hidden inside HTML comment block\"},{\"source\":\"(?:curl|wget|nc|netcat|python\\\\s+-c|bash\\\\s+-c)[^\\\\n]{0,60}(?:https?:\\\\/\\\\/|evil|exfil|attacker|C2)\",\"flags\":\"i\",\"label\":\"Shell exfiltration command\",\"layer\":\"L-2\",\"severity\":\"critical\",\"signal\":\"Shell command targeting external URL detected (potential data exfil)\"},{\"source\":\"@~\\\\/\\\\.ssh\\\\/|@~\\\\/\\\\.aws\\\\/|@~\\\\/\\\\.env\\\\b|@\\\\/etc\\\\/passwd|@\\\\/etc\\\\/shadow\",\"flags\":\"\",\"label\":\"Credential file exfiltration\",\"layer\":\"L-2\",\"severity\":\"critical\",\"signal\":\"Reference to sensitive credential file in exfil-style path\"},{\"source\":\"\\\\bsk-ant-[a-zA-Z0-9\\\\-_]{20,}\",\"flags\":\"\",\"label\":\"Anthropic API key exposure\",\"layer\":\"L0\",\"severity\":\"critical\",\"signal\":\"Anthropic API key pattern detected in payload\"},{\"source\":\"\\\\bsk-proj-[a-zA-Z0-9_-]{20,}\",\"flags\":\"\",\"label\":\"OpenAI project key exposure\",\"layer\":\"L0\",\"severity\":\"high\",\"signal\":\"OpenAI sk-proj-* project API key pattern detected\"},{\"source\":\"\\\\bsk-[a-zA-Z0-9]{20,}\",\"flags\":\"\",\"label\":\"OpenAI API key exposure\",\"layer\":\"L0\",\"severity\":\"high\",\"signal\":\"OpenAI-style API key pattern detected\"},{\"source\":\"\\\\bghp_[a-zA-Z0-9]{36,}\\\\b|\\\\bgh[ou]_[a-zA-Z0-9]{36,}\\\\b\",\"flags\":\"\",\"label\":\"GitHub token exposure\",\"layer\":\"L0\",\"severity\":\"high\",\"signal\":\"GitHub personal access token pattern detected\"},{\"source\":\"Bearer\\\\s+[a-zA-Z0-9\\\\-._~+/]+=*\",\"flags\":\"\",\"label\":\"Bearer token exposure\",\"layer\":\"L0\",\"severity\":\"high\",\"signal\":\"Bearer token detected in payload\"},{\"source\":\"(?:password|passwd|pwd)\\\\s*[:=]\\\\s*\\\\S{6,}\",\"flags\":\"i\",\"label\":\"Password exposure\",\"layer\":\"L0\",\"severity\":\"high\",\"signal\":\"Inline password assignment pattern detected\"}]"
# __P0_PATTERNS_END__

log = logging.getLogger("rai.intake_check")

_SEV_RANK = {"low": 1, "medium": 2, "high": 3, "critical": 4}


def _js_flags(flags: str) -> int:
    f = 0
    if "i" in flags:
        f |= re.IGNORECASE
    if "s" in flags:
        f |= re.DOTALL
    if "m" in flags:
        f |= re.MULTILINE
    return f


def _load_p0() -> List[Dict[str, Any]]:
    out = []
    for p in json.loads(P0_PATTERNS_JSON):
        try:
            out.append(
                {
                    "re": re.compile(p["source"], _js_flags(p.get("flags", ""))),
                    "label": p["label"],
                    "layer": p["layer"],
                    "severity": p["severity"],
                    "signal": p["signal"],
                }
            )
        except re.error:
            # A pattern that does not port is skipped, never silently widened.
            continue
    return out


P0 = _load_p0()

# ---------------------------------------------------------------------------
# L2 hidden-channel heuristics (ported from packages/core/repo-scan.ts)
# ---------------------------------------------------------------------------
SYSTEM_OVERRIDE = [
    re.compile(r"system\s*message\s*:", re.I),
    re.compile(r"\[?\s*system\s*prompt\s*\]?\s*:", re.I),
    re.compile(r"ignore\s+(all\s+|any\s+)?(previous|prior|above)\s+instructions", re.I),
    re.compile(r"disregard\s+(all\s+|any\s+)?(previous|prior)\s+(instructions|prompts)", re.I),
    re.compile(r"you\s+are\s+now\s+(a|an)\b", re.I),
    re.compile(r"new\s+instructions\s*:", re.I),
    re.compile(r"do\s+not\s+(mention|reveal|include)\s+this\s+(notice|instruction)", re.I),
    re.compile(r"assistant\s+will\s+now", re.I),
]
BASE64_BLOB = re.compile(r"(?:[A-Za-z0-9+/]{44,}={0,2})")
ZERO_WIDTH = re.compile("[​-‍﻿]")
UNICODE_TAG = re.compile("[\U000e0001\U000e0020-\U000e007f]")
BIDI_OVERRIDE = re.compile("[‪-‮⁦-⁩]")
HTML_COMMENT = re.compile(r"<!--([\s\S]*?)-->")
MD_IMAGE = re.compile(r"!\[([^\]]*)\]\(([^)]*)\)")
HTML_IMG_ALT = re.compile(r"<img\b[^>]*\balt=[\"']([^\"']*)[\"'][^>]*>", re.I)
MD_LINK_TITLE = re.compile(r"\[[^\]]*\]\([^)]+\s+\"([^\"]*)\"\)")
HTML_TITLE_ATTR = re.compile(r"\btitle=[\"']([^\"']*)[\"']", re.I)


def _trunc(s: str, n: int = 100) -> str:
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= n else s[:n] + "..."


def _override_hit(text: str) -> bool:
    return any(p.search(text) for p in SYSTEM_OVERRIDE)


def _hidden_hit(text: str) -> bool:
    return bool(ZERO_WIDTH.search(text) or UNICODE_TAG.search(text) or BIDI_OVERRIDE.search(text))


def scan_text(text: str, layers: Optional[set] = None) -> List[Dict[str, Any]]:
    """Return a list of signals for one text. Each signal:
    {label, layer, severity, signal, excerpt, span:(start,end)|None}."""
    if not text:
        return []
    signals: List[Dict[str, Any]] = []

    # P0 floor
    for p in P0:
        if layers and p["layer"] not in layers:
            continue
        m = p["re"].search(text)
        if m:
            signals.append(
                {
                    "label": p["label"],
                    "layer": p["layer"],
                    "severity": p["severity"],
                    "signal": p["signal"],
                    "excerpt": _trunc(m.group(0), 80),
                    "span": m.span(),
                }
            )

    if layers and "L2" not in layers:
        return _dedupe(signals)

    # L2 hidden channels
    if _hidden_hit(text):
        m = ZERO_WIDTH.search(text) or UNICODE_TAG.search(text) or BIDI_OVERRIDE.search(text)
        i = m.start()
        signals.append(
            {
                "label": "Hidden characters",
                "layer": "L2",
                "severity": "high",
                "signal": "Zero-width, Unicode-tag or bidi-override characters in text (invisible content)",
                "excerpt": _trunc(text[max(0, i - 40) : i + 40]),
                "span": None,
            }
        )
    for m in HTML_COMMENT.finditer(text):
        body = m.group(1)
        if _override_hit(body) or _hidden_hit(body):
            signals.append(
                {
                    "label": "Instruction in HTML comment",
                    "layer": "L2",
                    "severity": "high",
                    "signal": "Instruction-like text hidden in an HTML comment",
                    "excerpt": _trunc(body),
                    "span": m.span(),
                }
            )
    for rx, label in (
        (MD_IMAGE, "Instruction in image alt text"),
        (HTML_IMG_ALT, "Instruction in image alt text"),
        (MD_LINK_TITLE, "Instruction in link title"),
        (HTML_TITLE_ATTR, "Instruction in link title"),
    ):
        for m in rx.finditer(text):
            t = m.group(1) or ""
            if t and (_override_hit(t) or _hidden_hit(t)):
                signals.append(
                    {
                        "label": label,
                        "layer": "L2",
                        "severity": "high",
                        "signal": "Instruction-like text in a field the reader never sees",
                        "excerpt": _trunc(t),
                        "span": m.span(),
                    }
                )
    for m in BASE64_BLOB.finditer(text):
        blob = m.group(0)
        decoded = ""
        try:
            decoded = base64.b64decode(blob + "=" * (-len(blob) % 4), validate=False).decode("utf-8", "ignore")
        except Exception:
            decoded = ""
        if decoded and _override_hit(decoded):
            signals.append(
                {
                    "label": "Instruction in base64 blob",
                    "layer": "L2",
                    "severity": "high",
                    "signal": "Base64 content decodes to instruction-like text",
                    "excerpt": _trunc(decoded),
                    "span": m.span(),
                }
            )
    return _dedupe(signals)


def _dedupe(signals: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    best: Dict[str, Dict[str, Any]] = {}
    for s in signals:
        cur = best.get(s["label"])
        if cur is None or _SEV_RANK[s["severity"]] > _SEV_RANK[cur["severity"]]:
            best[s["label"]] = s
    return sorted(best.values(), key=lambda s: -_SEV_RANK[s["severity"]])


def strip_spans(text: str, signals: List[Dict[str, Any]]) -> str:
    """Remove matched spans (and all hidden characters) from text."""
    spans = sorted([s["span"] for s in signals if s.get("span")], reverse=True)
    for a, b in spans:
        text = text[:a] + "[removed by RA(I)]" + text[b:]
    text = ZERO_WIDTH.sub("", text)
    text = UNICODE_TAG.sub("", text)
    text = BIDI_OVERRIDE.sub("", text)
    return text


def summarize(where: str, signals: List[Dict[str, Any]]) -> str:
    top = signals[0]
    more = f" (+{len(signals) - 1} more)" if len(signals) > 1 else ""
    return f"RA(I) signal · {top['layer']} · {top['label']} in {where}: {top['signal']}{more}"


# ---------------------------------------------------------------------------
# Open WebUI message helpers
# ---------------------------------------------------------------------------
def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text")
    return ""


def _set_text(msg: Dict[str, Any], new_text: str) -> None:
    c = msg.get("content")
    if isinstance(c, list):
        done = False
        for part in c:
            if isinstance(part, dict) and part.get("type") == "text":
                part["text"] = new_text if not done else ""
                done = True
        if not done:
            c.insert(0, {"type": "text", "text": new_text})
    else:
        msg["content"] = new_text


def _last_message(body: Dict[str, Any], role: str) -> Optional[Dict[str, Any]]:
    for m in reversed(body.get("messages") or []):
        if m.get("role") == role:
            return m
    return None


def _file_texts(body: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Uploaded-file text already present inline in the body (shape varies by
    release; walk defensively). Returns [{name, text, ref}] where ref is the
    dict holding the text so it can be edited in place."""
    out = []
    files = body.get("files") or (body.get("metadata") or {}).get("files") or []
    for f in files:
        if not isinstance(f, dict):
            continue
        name = f.get("name") or (f.get("file") or {}).get("filename") or f.get("id") or "file"
        holder = None
        for cand in (f, f.get("file") or {}, (f.get("file") or {}).get("data") or {}, f.get("data") or {}):
            if isinstance(cand, dict) and isinstance(cand.get("content"), str):
                holder = cand
                break
        if holder is not None:
            out.append({"name": str(name), "text": holder["content"], "ref": holder, "entry": f})
    return out


# ---------------------------------------------------------------------------
# Filter
# ---------------------------------------------------------------------------
class Filter:
    class Valves(BaseModel):
        priority: int = Field(default=0, description="Filter order; lower runs first.")
        scan_retrieved_context: bool = Field(default=True, description="Scan retrieved knowledge / document chunks before the model sees them.")
        scan_outputs: bool = Field(default=True, description="Scan model replies for exposed secrets (L-2) and warn. Replies are never modified.")

    class UserValves(BaseModel):
        action: str = Field(
            default="warn",
            description="What to do on a signal: warn (show it, change nothing), strip (remove the flagged span, keep the rest), drop (keep the whole item out of this turn).",
        )
        local_log: bool = Field(default=False, description="Keep a per-signal counter in ~/.rai/intake-check-log.json on this machine. Nothing is sent anywhere.")
        show_clean: bool = Field(default=False, description="Also show a short 'checked, no signals' status.")

    def __init__(self):
        self.valves = self.Valves()

    # -- helpers ------------------------------------------------------------
    @staticmethod
    def _action(user: Optional[dict]) -> str:
        try:
            a = (user or {}).get("valves").action  # type: ignore[union-attr]
        except Exception:
            a = "warn"
        return a if a in ("warn", "strip", "drop") else "warn"

    @staticmethod
    def _uv(user: Optional[dict], name: str, default):
        try:
            return getattr((user or {}).get("valves"), name)
        except Exception:
            return default

    @staticmethod
    def _log_local(signals: List[Dict[str, Any]]) -> None:
        try:
            path = os.path.join(os.path.expanduser("~"), ".rai", "intake-check-log.json")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            data = {}
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
            counts = data.setdefault("counts", {})
            for s in signals:
                key = f"{s['layer']}:{s['label']}"
                counts[key] = counts.get(key, 0) + 1
            data["updated"] = int(time.time())
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=1)
        except Exception:
            pass

    @staticmethod
    async def _emit(emitter: Optional[Callable], text: str, level: str = "warning", done: bool = True) -> None:
        if not emitter:
            return
        try:
            await emitter({"type": "status", "data": {"description": text, "done": done}})
            if level in ("warning", "error"):
                await emitter({"type": "notification", "data": {"type": level, "content": text}})
        except Exception:
            pass

    async def _handle(self, where: str, text: str, signals: List[Dict[str, Any]], action: str, user, emitter) -> Dict[str, Any]:
        """Apply the user's action. Returns {text, dropped, note}."""
        if self._uv(user, "local_log", False):
            self._log_local(signals)
        head = summarize(where, signals)
        log.info("%s [action=%s]", head, action)  # server log on this machine only
        if action == "strip":
            note = f"{head}. Flagged span removed, rest kept. Set action=warn to keep everything."
            await self._emit(emitter, note)
            return {"text": strip_spans(text, signals), "dropped": False, "note": note}
        if action == "drop":
            note = f"{head}. Kept out of this answer. Set action=warn and re-send to use it anyway."
            await self._emit(emitter, note)
            return {"text": "", "dropped": True, "note": note}
        note = f"{head}. Passed through unchanged. Decide before you act on it."
        await self._emit(emitter, note)
        return {"text": text, "dropped": False, "note": note}

    # -- hooks --------------------------------------------------------------
    async def inlet(self, body: dict, __user__: Optional[dict] = None, __event_emitter__: Optional[Callable] = None) -> dict:
        action = self._action(__user__)
        notes: List[str] = []
        total = 0

        # 1. latest user message (what you typed or pasted)
        msg = _last_message(body, "user")
        if msg is not None:
            text = _content_to_text(msg.get("content"))
            sigs = scan_text(text)
            if sigs:
                total += len(sigs)
                r = await self._handle("your message", text, sigs, action, __user__, __event_emitter__)
                notes.append(r["note"])
                if r["dropped"]:
                    _set_text(msg, "[The user chose to withhold this message. Reply briefly that the message was held back by their own intake check; the user already sees the details.]")
                elif r["text"] != text:
                    _set_text(msg, r["text"])

        # 2. uploaded file text present inline (pre-retrieval)
        for f in _file_texts(body):
            sigs = scan_text(f["text"])
            if not sigs:
                continue
            total += len(sigs)
            r = await self._handle(f'"{f["name"]}"', f["text"], sigs, action, __user__, __event_emitter__)
            notes.append(r["note"])
            if r["dropped"]:
                f["ref"]["content"] = "[Document withheld by the user. Do not speculate about its contents.]"
                files = body.get("files")
                if isinstance(files, list) and f["entry"] in files:
                    files.remove(f["entry"])
            elif r["text"] != f["text"]:
                f["ref"]["content"] = r["text"]

        if total == 0 and self._uv(__user__, "show_clean", False):
            await self._emit(__event_emitter__, "RA(I): checked, no signals.", level="info")
        return body

    async def request(self, body: dict, __user__: Optional[dict] = None, __event_emitter__: Optional[Callable] = None) -> dict:
        """Post-retrieval, pre-model: the messages now carry retrieved knowledge
        chunks and uploaded-document context (system or latest user message)."""
        if not self.valves.scan_retrieved_context:
            return body
        action = self._action(__user__)
        # Open WebUI puts retrieved context into the system message or, depending
        # on its RAG setting, into the latest user message. Scan both.
        targets = [m for m in body.get("messages") or [] if m.get("role") == "system"]
        last_user = _last_message(body, "user")
        if last_user is not None:
            targets.append(last_user)
        for m in targets:
            text = _content_to_text(m.get("content"))
            if not text:
                continue
            sigs = scan_text(text)
            if not sigs:
                continue
            r = await self._handle("retrieved context", text, sigs, action, __user__, __event_emitter__)
            if r["dropped"]:
                _set_text(m, "[Retrieved context withheld by the user for this turn. Answer without it and say so in one sentence.]")
            elif r["text"] != text:
                _set_text(m, r["text"])
        return body

    async def outlet(self, body: dict, __user__: Optional[dict] = None, __event_emitter__: Optional[Callable] = None) -> dict:
        if not self.valves.scan_outputs:
            return body
        msg = _last_message(body, "assistant")
        if msg is None:
            return body
        sigs = scan_text(_content_to_text(msg.get("content")), layers={"L-2"})
        if sigs:
            if self._uv(__user__, "local_log", False):
                self._log_local(sigs)
            await self._emit(__event_emitter__, summarize("the reply", sigs) + ". Reply left as is; check before you copy it anywhere.")
        return body
