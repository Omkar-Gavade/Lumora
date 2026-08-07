import { useEffect, useState } from 'react';

/**
 * Returns the id of the section currently occupying the reading position.
 *
 * Uses a rootMargin band near the top of the viewport rather than "most
 * visible": with sections of wildly different heights, a visibility ranking
 * makes the indicator jump backwards on a tall section, which reads as a bug.
 * A fixed band tracks where the user is actually reading.
 */
export function useScrollSpy(ids: readonly string[], offset = 88): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;

    const visible = new Set<string>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        // When two adjacent sections both touch the band, the later one is the
        // one being scrolled into — picking the earlier leaves the indicator
        // one section behind at every boundary.
        let next: string | null = null;
        for (const id of ids) if (visible.has(id)) next = id;
        setActiveId(next);
      },
      // A narrow band just under the header. Wider bands make two sections
      // qualify at once for most of the scroll.
      { rootMargin: `-${offset}px 0px -72% 0px`, threshold: 0 },
    );

    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);

    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [ids, offset]);

  return activeId;
}
