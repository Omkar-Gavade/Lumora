import { useEffect, useRef } from 'react';

/**
 * Reveals an element once, when it first enters the viewport.
 *
 * Deliberately one-way: re-hiding on scroll-up is decoration that makes a page
 * feel restless. If the user prefers reduced motion, the element is revealed
 * immediately and no observer is created at all.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion || typeof IntersectionObserver === 'undefined') {
      element.setAttribute('data-revealed', 'true');
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute('data-revealed', 'true');
          observer.unobserve(entry.target);
        }
      },
      // Fire slightly before the element is fully on screen so the motion has
      // finished by the time the user is actually looking at it.
      { rootMargin: '0px 0px -10% 0px', threshold: 0.05 },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return ref;
}
