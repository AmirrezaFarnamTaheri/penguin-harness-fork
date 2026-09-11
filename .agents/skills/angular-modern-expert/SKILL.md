---
name: angular-modern-expert
description: Authoritative guide for modern Angular (v17+) architecture covering Signals, Standalone Components, new Control Flow (@if, @for, @switch), Server-Side Rendering (SSR), Reactive Forms, Dependency Injection, and Jasmine/Jest testing.
---

# Modern Angular Expert (v17+)

Architect production-ready, performant, and scalable applications using contemporary Angular best practices.

## Core Pillars of Modern Angular

### 1. Standalone Components by Default
- Avoid NgModules. Every component, directive, and pipe is standalone (`standalone: true` or default in v17+).
- Explicit imports: declare dependencies directly in the `@Component({ imports: [CommonModule, RouterLink, ...], ... })` decorator.

### 2. Angular Signals & Reactivity
- Use `signal()`, `computed()`, and `effect()` for reactive state management:
  ```typescript
  import { Component, signal, computed } from '@angular/core';

  @Component({
    selector: 'app-counter',
    standalone: true,
    template: `
      <p>Count: {{ count() }}</p>
      <p>Double: {{ doubleCount() }}</p>
      <button (click)="increment()">Increment</button>
    `,
  })
  export class CounterComponent {
    count = signal(0);
    doubleCount = computed(() => this.count() * 2);

    increment() {
      this.count.update(n => n + 1);
    }
  }
  ```
- Use `toSignal()` and `toObservable()` from `@angular/core/rxjs-interop` when integrating with RxJS streams.

### 3. Built-in Control Flow
- Replace `*ngIf`, `*ngFor`, and `*ngSwitch` with built-in block template syntax:
  ```html
  @if (user(); as u) {
    <h1>Welcome, {{ u.name }}</h1>
  } @else {
    <p>Please log in.</p>
  }

  @for (item of items(); track item.id) {
    <div>{{ item.title }}</div>
  } @empty {
    <p>No items found.</p>
  }
  ```

### 4. Dependency Injection & Functional Guards
- Prefer `inject()` over constructor injection:
  ```typescript
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  ```
- Use functional route guards and resolvers (`canActivate: [() => inject(AuthService).isLoggedIn()]`).

### 5. Server-Side Rendering (SSR) & Hydration
- Utilize `@angular/ssr` with non-destructive hydration.
- Guard browser-specific APIs using `isPlatformBrowser(inject(PLATFORM_ID))`.

### 6. Robust Testing
- Write isolated unit tests using `TestBed` and `ComponentFixture`.
- Prefer native signal assertion (`expect(component.count()).toBe(1)`) over manual change detection cycles where possible.
