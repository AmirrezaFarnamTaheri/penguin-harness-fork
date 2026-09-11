---
name: gsap-animation-master
description: Complete GreenSock Animation Platform (GSAP 3) engineering suite covering Timelines, ScrollTrigger, React integration (useGSAP), plugins, SVG morphing, and GPU performance optimization.
---

# GSAP Animation Master

Architect smooth, performant, and complex web animations using the GreenSock Animation Platform (GSAP 3+).

## Core Capabilities

### 1. Timelines & Sequencing
- Build deterministic sequential animations using `gsap.timeline({ defaults: { ease: "power2.out", duration: 0.6 } })`.
- Utilize relative and absolute position parameters (`"<"`, `"-=0.2"`, `"+=0.5"`) for micro-staggering.
- Implement timeline nesting for modular scene composition.

### 2. ScrollTrigger Orchestration
- Bind animations to viewport scroll coordinates with `ScrollTrigger.create({ trigger: el, start: "top 80%", end: "bottom 20%", scrub: true, pin: true })`.
- Configure `toggleActions` (`"play none none reverse"`).
- Manage horizontal scrolling and pin-spacer offsets.

### 3. Modern React & Next.js Integration
- Utilize `@gsap/react` with the `useGSAP` hook for automatic cleanup and context scoping:
  ```tsx
  import { useRef } from "react";
  import gsap from "gsap";
  import { useGSAP } from "@gsap/react";
  import { ScrollTrigger } from "gsap/ScrollTrigger";

  gsap.registerPlugin(useGSAP, ScrollTrigger);

  export function AnimatedHero() {
    const container = useRef<HTMLDivElement>(null);

    useGSAP(() => {
      gsap.from(".fade-in", { opacity: 0, y: 30, stagger: 0.1, duration: 0.8 });
    }, { scope: container });

    return <div ref={container}>...</div>;
  }
  ```

### 4. Plugins & Advanced FX
- **Flip**: Seamless layout transitions without layout thrashing.
- **MorphSVG**: Smooth vector path morphing between distinct SVG shapes.
- **SplitText**: Word-by-word, character-by-character staggered typography reveals.
- **Draggable**: Physics-enabled gestures, bounds checking, and momentum inertia.

### 5. High-Performance & GPU Guidelines
- Animate only composite-safe properties (`transform: translate3d/scale/rotate`, `opacity`).
- Avoid animating layout triggers (`width`, `height`, `margin`, `padding`, `top`, `left`).
- Use `will-change: transform` sparingly on active animating elements.
- Always clean up timelines and ScrollTriggers on unmount (`ctx.revert()` or `ScrollTrigger.killAll()`).
