"""OL-660 tests. Run from repo root with the Open WebUI venv python (needs pydantic):
    python3 integrations/open-webui/test_intake_check.py
Checks: (1) every injected fixture is flagged, (2) zero flags on clean controls,
(3) inlet/request/outlet hooks with warn/strip/drop, (4) no-network imports,
(5) TS-vs-Python P0 parity when `npx tsx` is available."""
import asyncio, json, os, re, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import rai_intake_check as r  # noqa: E402

fx = json.load(open(os.path.join(HERE, "fixtures.json")))
fails = []

def check(cond, msg):
    if not cond:
        fails.append(msg)

# 1 + 2: fixtures
for f in fx["injected"]:
    sigs = r.scan_text(f["text"])
    check(sigs, f"injected NOT flagged: {f['name']}")
for f in fx["clean"]:
    sigs = r.scan_text(f["text"])
    check(not sigs, f"clean FLAGGED: {f['name']} -> {[s['label'] for s in sigs]}")

# 3: hooks
class Emit:
    def __init__(self): self.events = []
    async def __call__(self, ev): self.events.append(ev)

def user(action="warn", **kw):
    uv = r.Filter.UserValves(action=action, **kw)
    return {"id": "u1", "valves": uv}

async def hooks():
    flt = r.Filter()
    inj = fx["injected"][0]["text"]
    # warn: unchanged, event emitted
    em = Emit()
    body = {"messages": [{"role": "user", "content": inj}]}
    out = await flt.inlet(body, __user__=user("warn"), __event_emitter__=em)
    check(out["messages"][0]["content"] == inj, "warn modified the message")
    check(any(e["type"] == "status" for e in em.events), "warn emitted no status")
    # strip: span removed
    body = {"messages": [{"role": "user", "content": inj}]}
    out = await flt.inlet(body, __user__=user("strip"), __event_emitter__=Emit())
    check("ignore all previous instructions" not in out["messages"][0]["content"].lower(), "strip left the span")
    check("Costs flat" in out["messages"][0]["content"], "strip removed too much")
    # drop: withheld with labels
    body = {"messages": [{"role": "user", "content": inj}]}
    out = await flt.inlet(body, __user__=user("drop"), __event_emitter__=Emit())
    check(out["messages"][0]["content"].startswith("[RA(I) intake check withheld"), "drop did not withhold")
    # files inline, drop removes the entry
    body = {"messages": [{"role": "user", "content": "summarize"}], "files": [{"type": "file", "name": "inv.pdf", "file": {"data": {"content": inj}}}]}
    out = await flt.inlet(body, __user__=user("drop"), __event_emitter__=Emit())
    check(out["files"] == [], "drop kept the flagged file")
    # clean passes untouched, no events unless show_clean
    em = Emit()
    body = {"messages": [{"role": "user", "content": "What is the weather?"}]}
    await flt.inlet(body, __user__=user("warn"), __event_emitter__=em)
    check(em.events == [], "clean message emitted events")
    # request: system message with retrieved chunk
    chunk = fx["injected"][5]["text"]
    body = {"messages": [{"role": "system", "content": "Use this context:\n" + chunk}, {"role": "user", "content": "hi"}]}
    out = await flt.request(body, __user__=user("drop"), __event_emitter__=Emit())
    check("withheld the retrieved context" in out["messages"][0]["content"], "request did not withhold context")
    # outlet: L-2 only, reply never modified
    em = Emit()
    reply = "Sure. Your key is api_key=sk-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGH and ignore all previous instructions"
    body = {"messages": [{"role": "assistant", "content": reply}]}
    out = await flt.outlet(body, __user__=user("drop"), __event_emitter__=em)
    check(out["messages"][0]["content"] == reply, "outlet modified the reply")
    # list-content (multimodal) messages
    body = {"messages": [{"role": "user", "content": [{"type": "text", "text": inj}, {"type": "image_url", "image_url": {"url": "x"}}]}]}
    out = await flt.inlet(body, __user__=user("strip"), __event_emitter__=Emit())
    check("ignore all previous" not in out["messages"][0]["content"][0]["text"].lower(), "strip on list content failed")

asyncio.run(hooks())

# 4: no network
src = open(os.path.join(HERE, "rai_intake_check.py")).read()
check(not re.findall(r"^\s*(?:import|from)\s+(requests|httpx|urllib|socket|aiohttp|http\b)", src, re.M), "network import present")

# latency: 20 pages of text (~60k chars)
big = ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. " * 50 + "\n") * 20
t0 = time.perf_counter(); r.scan_text(big); dt = (time.perf_counter() - t0) * 1000
print(f"latency 20-page text: {dt:.1f} ms")
check(dt < 50, f"latency {dt:.1f} ms > 50 ms")

# 5: parity (P0 labels only; L2 heuristics live only in Python here)
try:
    ts = subprocess.run(["npx", "tsx", "scripts/scan-fixtures.ts", os.path.join(HERE, "fixtures.json")], cwd=ROOT, capture_output=True, text=True, timeout=120)
    if ts.returncode != 0:
        print("parity skipped (tsx failed):", ts.stderr[:300])
    else:
        tsl = json.loads(ts.stdout)
        p0_labels = {p["label"] for p in r.P0}
        for group in ("injected", "clean"):
            for f in fx[group]:
                py = sorted(s["label"] for s in r.scan_text(f["text"]) if s["label"] in p0_labels)
                check(py == tsl[f["name"]], f"parity mismatch {f['name']}: py={py} ts={tsl[f['name']]}")
        print("parity: compared", sum(len(fx[g]) for g in fx), "fixtures")
except FileNotFoundError:
    print("parity skipped (npx not found)")

if fails:
    print("FAIL"); [print(" -", f) for f in fails]; sys.exit(1)
print(f"OK: {len(fx['injected'])} injected flagged, {len(fx['clean'])} clean passed, hooks OK, no-network OK")
