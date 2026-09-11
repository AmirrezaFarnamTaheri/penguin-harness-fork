---
name: stitch-design-architect
description: Comprehensive design system specification, design token extraction, and DESIGN.md generation for UI/UX applications.
---

# Stitch Design Architect

Architect complete design systems, extract design tokens from screenshots or existing codebases, and establish structured `DESIGN.md` documentation.

## Core Capabilities

1. **Design Token Extraction**:
   - Extract primary, secondary, neutral, and accent color palettes with exact HEX/HSL/RGB values.
   - Standardize typographic scales (display, h1-h6, body, caption, code) with explicit line heights and letter spacing.
   - Establish elevation systems (box shadows, border bevels, layer blur radii).
   - Define spacing scales (multiples of 4px/8px) and border radiuses.

2. **`DESIGN.md` Specification**:
   - Generate authoritative design specifications defining:
     - Design tokens (CSS custom properties / Tailwind configuration).
     - Component library contracts (Button, Card, Input, Modal, Table).
     - Visual tone (e.g., modern dark glass, editorial brutalist, crisp corporate).
     - Accessibility constraints (WCAG AA contrast ratios, focus rings, ARIA roles).

3. **Multi-Surface Coordination**:
   - Align mobile, desktop, and responsive breakpoint rules (`sm: 640px`, `md: 768px`, `lg: 1024px`, `xl: 1280px`).
   - Synchronize light and dark mode color token definitions.
