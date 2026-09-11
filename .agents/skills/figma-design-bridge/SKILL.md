---
name: figma-design-bridge
description: Unified end-to-end Figma integration workflow for extracting design tokens, generating component libraries, Code Connect mapping, and implementing pixel-perfect UI code.
---

# Figma Design Bridge

Bridge the gap between Figma design files and production code through a unified 4-stage pipeline: Extract, Generate, Connect, and Implement.

## Pipeline Stages

### Stage 1: Extraction (`extract`)
- Authenticate via Figma REST API with personal access token (`X-Figma-Token`).
- Traverse canvas documents to extract node hierarchies, vector paths, styles, and variable collections.
- Export color styles, typography tokens, grid geometries, and elevation drop-shadows into standardized JSON.

### Stage 2: Library Generation (`generate`)
- Convert extracted Figma variables into Tailwind CSS config or CSS custom properties (`:root { ... }`).
- Generate icon sprites and SVG components from vector frames.
- Formulate comprehensive design system documentation (`DESIGN.md`).

### Stage 3: Figma Code Connect (`connect`)
- Map Figma component instances and component variants directly to codebase React/Vue components.
- Configure `@figma/code-connect` definition files (`.figma.tsx`) binding Figma variant properties (e.g. `size`, `variant`, `state`) to React props.

### Stage 4: Implementation (`implement`)
- Translate Figma layout frames (AutoLayout vertical/horizontal, gap, padding, hug/fill sizing) into modern Flexbox and CSS Grid layouts.
- Replicate responsive behavior and typography line-heights with pixel fidelity.
- Validate resulting implementation against design node dimensions.
