# RAI Surface Architecture v2
_Version: v2 | Date: 2026-05-13 | Source: cd:2026-05-13_
_Ref: rai_surface_architecture_v2 widget_

---

## Ambient Levels × Device Context

### OS-Level Ambient (always on)
| Surface | Device | Effort | Notes |
|---|---|---|---|
| Keyboard Extension | Mobile (iOS) | Hard | App Store Review, UX-Hürde (Aktivierung) — V1 Consumer |
| Accessibility Service | Mobile (Android) | Hard | Play Store, Privacy-Scrutiny — stärkstes Android Ambient |
| Menubar App | Desktop (macOS) | Medium | OL-242b |
| Menubar App | Desktop (Windows) | Medium | Nach macOS-Validated-Pattern |

### App-Level Ambient (in context)
| Surface | Device | Effort | Notes |
|---|---|---|---|
| Telegram Bot | Mobile | Easy | OL-117 live |
| Notification Extension | Mobile (iOS) | Medium | Messaging-Schutz |
| Safari Extension | Mobile (iOS 15+) | Medium | App Store Review |
| Browser Extension (Chrome) | Desktop | Easy | Live, OL-241 |
| PWA | Desktop/Mobile | Easy | Live |
| VS Code / IDE Extension | Desktop | Medium | Dev-Tier, AI-Code-Trust-Layer |
| Claude Desktop | AI Interface | Easy | Hook / DOM Scan, OL-235 → RAI |
| ChatGPT.com | AI Interface | Easy | DOM Scan |
| Claude Code | AI Interface | Easy | PreToolUse Hook |
| Any AI CLI | AI Interface | Medium | Hook Adapter |
| Gmail Plugin | Comms | Easy | Chrome Extension Manifest V3, höchste Threat-Dichte |
| Outlook Add-in | Comms | Medium | Office JS API, B2B/Enterprise |
| Apple Mail Extension | Comms | Medium | MailKit |

### Manual / Opt-in
| Surface | Device | Effort | Notes |
|---|---|---|---|
| Share Sheet | Mobile (iOS) | Easy | Day-1 Consumer MVP, Wochen |
| Web Scanner | Desktop | Easy | |
| Clipboard scan | Desktop | Easy | |
| Forwarded-msg scan | Comms | Easy | Via Share Sheet oder Bot |
| npm @rai/core | Dev | Easy | |
| REST API | Dev | Easy | |

---

## Realisierbarketsranking

### Jetzt (Easy, Tage bis Wochen)
1. Telegram Bot + Browser Ext + PWA — live oder Tage, OL-241 Smoke Test
2. Claude Desktop + ChatGPT.com + Claude Code — Hook/DOM, Tage, OL-235 → RAI
3. Share Sheet (iOS) — Day-1 Consumer Distribution MVP, Wochen
4. Gmail Plugin — Chrome Ext MV3, Wochen, email = highest-threat surface

### Mittel (Medium, Wochen bis Monate)
5. Menubar App (macOS) — Swift/Electron, OL-242b
6. VS Code Extension — Dev-Tier, AI-Code-Trust-Layer
7. Safari Extension + Notification Extension — iOS, App Store Review
8. Outlook Add-in + Apple Mail — B2B/Enterprise Angle

### Später (Hard, Monate)
9. iOS Keyboard Extension — V1 Consumer Ambient, App Store Review, UX-Hürde
10. Android Accessibility Service — stärkstes Android Ambient, Privacy-Scrutiny
11. Windows Menubar — nach macOS-Validated-Pattern

### Parken
- Voice Skill — L6 Future Threat Layer, anderer Stack, kein aktuelles RAI-Problem

---

## Key Cross-References
- OL-117: Telegram Beachhead → Phase 3 Community Layer Trigger
- OL-235: Hook Architecture → direkte RAI AI Interface Integration
- OL-241: Cross-Surface Distributed Node (Extension + PWA + NanoClaw)
- OL-242b: Native Mobile als primärer Consumer Ambient Layer
- Android Accessibility Service = funktional identisch mit iOS Keyboard Extension (OS-level, greets every app)
- Gmail Plugin = Chrome Extension MV3 = sehr nahe an Browser Extension (gleicher Stack, anderer Scope)
