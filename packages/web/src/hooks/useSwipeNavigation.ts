import { useRef, useCallback } from "react";

interface UseSwipeNavigationOptions {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  /** Minimum horizontal travel in px to count as a swipe */
  threshold?: number;
}

/**
 * Returns touch event handlers for horizontal swipe detection.
 * Only triggers if horizontal travel exceeds vertical travel (so vertical
 * scrolling in StreamOutput is not hijacked).
 */
export function useSwipeNavigation({
  onSwipeLeft,
  onSwipeRight,
  threshold = 60,
}: UseSwipeNavigationOptions) {
  const startX = useRef(0);
  const startY = useRef(0);
  const tracking = useRef(false);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) {
      tracking.current = false;
      return;
    }
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    tracking.current = true;
  }, []);

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!tracking.current) return;
      tracking.current = false;
      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;
      const dx = endX - startX.current;
      const dy = endY - startY.current;
      // Only trigger if horizontal motion dominates and exceeds threshold
      if (Math.abs(dx) < Math.abs(dy)) return;
      if (Math.abs(dx) < threshold) return;
      if (dx < 0) onSwipeLeft?.();
      else onSwipeRight?.();
    },
    [onSwipeLeft, onSwipeRight, threshold],
  );

  const onTouchCancel = useCallback(() => {
    tracking.current = false;
  }, []);

  return { onTouchStart, onTouchEnd, onTouchCancel };
}
