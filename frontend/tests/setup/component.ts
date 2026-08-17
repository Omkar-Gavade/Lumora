import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * `matchMedia`, which jsdom does not implement.
 *
 * Anything rendered inside the app shell reaches `useMediaQuery` through
 * `SidebarProvider`, so without this every component test that mounts a piece
 * of the shell dies on "window.matchMedia is not a function" — an environment
 * gap that reads like a component bug.
 *
 * It reports **no match**, which resolves to the desktop layout: `isMobile`
 * and `isDesktop` both false puts the sidebar in its expanded default. Tests
 * that care about a specific viewport override this per-test rather than
 * relying on the default meaning anything.
 */
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

/**
 * A non-zero layout box, which jsdom also does not provide.
 *
 * jsdom runs no layout engine, so `getBoundingClientRect` reports zeros for
 * every element. `Menu` reads that rect to place its panel and closes itself
 * when the anchor measures 0×0 — which is correct in a browser, where a
 * zero-size anchor means the trigger has been hidden underneath an open menu,
 * and fatal in jsdom, where it means nothing at all. Left unstubbed, every
 * menu in the app appears to open and shut instantly and no menu item can be
 * tested.
 *
 * The numbers describe a plausible small trigger; nothing asserts on them.
 * They exist so the placement math has something real to divide.
 */
Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
  writable: true,
  value: () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 32,
    right: 32,
    width: 32,
    height: 32,
    toJSON: () => ({}),
  }),
});

/**
 * Unmounts between tests.
 *
 * Without it, every render stays in the document and `getByRole` starts
 * matching an element from a previous test — which fails as a confusing
 * "multiple elements" error a long way from the test that leaked.
 */
afterEach(cleanup);
