import { useEffect, useState, type RefObject } from 'react';

interface ScrollEdges {
  atStart: boolean;
  atEnd: boolean;
}

const EDGE_TOLERANCE_PX = 1;

export function useScrollEdges(ref: RefObject<HTMLElement | null>): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ atStart: true, atEnd: true });

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    function update() {
      if (!element) {
        return;
      }
      const { scrollLeft, scrollWidth, clientWidth } = element;
      const maxScroll = scrollWidth - clientWidth;
      setEdges({
        atStart: scrollLeft <= EDGE_TOLERANCE_PX,
        atEnd: scrollLeft >= maxScroll - EDGE_TOLERANCE_PX,
      });
    }

    update();
    element.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);

    return () => {
      element.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [ref]);

  return edges;
}
