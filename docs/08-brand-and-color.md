# HopeGrid Brand & Color System

HopeGrid (repository: ICS-LAS) is operated by Hiraeth Ventures.

- **Primary headline:** Help Is Closer Than You Think.
- **Primary call to action:** Find Help Near Me (uses the device location, then shows the nearest help first)
- **Secondary call to action:** Explore Resource Map
- **Organization call to action:** Register Your Organization

## Brand palette

| Color | Hex | Used for | Contrast notes (WCAG AA) |
|---|---|---|---|
| Hope Forest Green | `#205C4B` | Header/navigation, headings, primary buttons, map cluster circles | White text 7.8:1 |
| Community Blue | `#2684B8` | Map/interactive graphics, focus rings, input focus | 4.14:1 on white — **not used for text** |
| Community Blue (text) | `#1D6A95` | Links and secondary (outline) buttons | 5.6:1 on Warm Ivory |
| Recovery Mint | `#BDE8D2` (+ tint `#E9F6EF`) | Hero band, soft highlights, wordmark accent, "Public" badge | Charcoal 9.6:1, Forest 5.8:1 |
| Hope Gold | `#F0B84B` | Attention buttons (Find Help Near Me, Register Your Organization in the header), Limited status | Background only; Charcoal text 7.2:1 |
| Warm Ivory | `#FAF9F4` | Page background | — |
| Deep Charcoal | `#24343A` | Body text | 12.2:1 on Warm Ivory |
| Pure White | `#FFFFFF` | Cards, forms | — |
| Muted text | `#56666C` | Secondary text | 5.7:1 on Warm Ivory |

Tokens live in `src/app/globals.css` (`--hope-forest`, `--community-blue`, `--link`, …).

## Resource status colors (semantic — reserved)

Status colors are **never** used for organization types (a database CHECK, `service_types_not_status_color`, rejects them). Every status always shows **color + icon + text**.

| Status | Badge (list/detail) | Map pin badge | Icon |
|---|---|---|---|
| Available | green tint, `#1B5E20` text | `#2E7D32` circle, white **A** | check in circle |
| Limited | amber tint, `#6B4300` text | `#F0B84B` circle, charcoal **L** | warning triangle |
| Depleted | red tint, `#A61B1B` text | `#C62828` circle, white **D** | × in circle |
| Temporarily closed | gray, explicit label | `#B0BEC5` circle, charcoal **C** | pause square |
| Unknown / Unconfirmed (expired verification) | gray, dashed border | `#ECEFF1` circle, charcoal **?** | ? in dashed circle |

## Organization type colors

Each organization's admin-confirmed type colors its map pins, with a short code (e.g. **H2O**, **MED**, **CM**) printed on the pin. The palette avoids status hues (no green, amber, red or mid-gray). Every type color gives white text at least 4.5:1 (database CHECK `service_types_color_contrast`).

## Map key

The map key on the map (collapsed on phones, always shown on larger screens) explains every color and mark used:
1. **Availability** — the lettered badge on each pin (A / L / D / C / ?) with the matching status pill.
2. **Organization type** — pin color + code; tapping a type filters the map.
3. **Other marks** — numbered forest-green circles (groups of locations) and the thick dark outline (restricted, signed-in only).

## Verification

axe-core (WCAG 2.0/2.1/2.2 A + AA + best practice): 0 violations on Home/Map, Contacts, Sign in/Register, Safety, Dashboard and Site editor (2026-11-10, local dev). Phone width 375 px: no horizontal scroll; hero buttons 44 px tall.
