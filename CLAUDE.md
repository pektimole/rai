# RA(I) — AI Interaction Firewall

Ambient protection for every AI interaction. Zero data leaves your device.

## Architecture

Monorepo with three packages:

| Package | What | Status |
|---|---|---|
| `packages/core` | P0 regex scanner + P1 Claude API scanner | Extracted from NanoClaw, production-proven |
| `packages/p2-agent` | Multi-agent consensus (4 independent chains) | Scaffolded, agents stubbed |
| `packages/extension` | Chromium MV3 browser extension | MVP complete, builds, ready for CWS |

## Spec files

- `docs/19-rai-context.md` — product spec, threat model, integration points
- `docs/25-rai-extension-spec.md` — browser extension architecture
- `docs/26-rai-p2-spec.md` — P2 multi-agent consensus design
- `docs/28-rai-actiongate-spec.md` — L4 agent action firewall (lifts NanoClaw Write Gate into reusable policy engine)

## Threat Layer Schema

| Layer | Label | Coverage |
|---|---|---|
| L-2 | Infrastructure / supply chain | P0 + P1 |
| L-1 | Model poisoning / drift | P0 + P1 |
| L0 | Prompt injection | P0 + P1 |
| L1 | Misinformation | P1 |
| L2 | Cascade risk | P2 |
| L3 | Systemic harm | P2 |
| L4 | Agent action / unauthorized side-effect | ActionGate (spec) |

## Key decisions

- P0 is local regex, runs everywhere (browser, NanoClaw, API). Zero cost.
- P1 defaults to Haiku, escalates to Sonnet on low confidence (<0.65).
- P2 runs 4 independent agent chains in parallel, merges via consensus layer.
- Extension is P0-only for Free tier. P1/P2 for Pro/Premium.
- Brand: RA(I) visually, RAI in text/URLs, pronounced "Ray".

## Development

```bash
npm install          # Install all workspace deps
npm run build        # Build all packages
npm run test         # Test all packages
```

Extension dev:
```bash
cd packages/extension
npm run dev          # Vite HMR
npm run build        # Production build to dist/
npm run zip          # Package for CWS upload
```
