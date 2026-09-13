---
name: stitch-component-builder
description: Multi-target UI component generation from specifications or wireframes across React, React Native, Vite Dashboards, Shadcn UI, Remotion, and semantic HTML.
---

# Stitch Component Builder

Generate production-grade UI components with zero placeholders across modern frontend targets, adhering strictly to design token contracts.

## Supported Targets & Frameworks

- **React & Next.js**: Functional components with Tailwind CSS, Lucide icons, accessible keyboard navigation, and Radix/Headless primitives.
- **Shadcn UI**: Composition with `cn()` utility, CVA (Class Variance Authority) variants, and Radix UI primitives.
- **React Native**: Clean `StyleSheet.create` or NativeWind layouts optimized for iOS and Android touch boundaries.
- **Vite Dashboards**: Fast-loading dashboard layouts featuring high-density grid arrangements, responsive tables, and charts.
- **Remotion**: Programmatic React video compositions with frame-accurate animations and spring physics.
- **Static HTML/CSS**: Clean, self-contained HTML5 templates with vanilla CSS custom properties.

## Best Practices

1. **Strict Typing**: All component props must be explicitly typed with TypeScript interfaces.
2. **Interactive States**: Every clickable or focusable element must support default, hover, active, focus-visible, and disabled states.
3. **Responsive Execution**: Mobile-first layout composition using CSS Grid and Flexbox with zero horizontal overflow.
4. **Token Fidelity**: Use tokens declared in `DESIGN.md` rather than arbitrary inline styles.
