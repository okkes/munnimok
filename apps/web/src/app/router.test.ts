// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { AnyRoute } from '@tanstack/react-router';
import { routeTree } from './router';

describe('the route tree (#554)', () => {
  it('the first load draws only the shell, sign-in, onboarding and Home — every other screen loads on its first visit', () => {
    const eager: string[] = [];
    const walk = (route: AnyRoute) => {
      const component = route.options.component as { preload?: unknown } | undefined;
      if (component && typeof component.preload !== 'function') eager.push(route.id);
      for (const child of (route.children as AnyRoute[] | undefined) ?? []) walk(child);
    };
    walk(routeTree);
    // a new screen is declared with lazyScreen in router.tsx, or the first load grows again
    expect(eager).toEqual(['__root__', '/login', '/app', '/app/home', '/app/onboarding']);
  });
});
