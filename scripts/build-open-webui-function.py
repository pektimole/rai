#!/usr/bin/env python3
"""OL-660: regenerate the embedded P0 pattern block in
integrations/open-webui/rai_intake_check.py from packages/core/rai-scan-p0.ts.

  npx tsx scripts/export-p0-patterns.ts > integrations/open-webui/p0-patterns.json
  python3 scripts/build-open-webui-function.py

Also enforces the no-network rule (Constitution Rule 4) by grep."""
import json, re, sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
pj = root / "integrations/open-webui/p0-patterns.json"
py = root / "integrations/open-webui/rai_intake_check.py"
patterns = json.load(open(pj))
block = "P0_PATTERNS_JSON = " + json.dumps(json.dumps(patterns, separators=(",", ":"), ensure_ascii=True)) + "\n"
src = py.read_text()
new = re.sub(r"(# __P0_PATTERNS_BEGIN__\n)(.*?)(# __P0_PATTERNS_END__)", lambda m: m.group(1) + block + m.group(3), src, flags=re.S)
py.write_text(new)
bad = re.findall(r"^\s*(?:import|from)\s+(requests|httpx|urllib|socket|aiohttp|http\b)", new, flags=re.M)
if bad:
    print("NO-NETWORK CHECK FAILED:", bad); sys.exit(1)
print(f"embedded {len(patterns)} patterns; no-network check OK")
