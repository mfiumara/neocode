export const TRANSCRIPT_BOTTOM_THRESHOLD = 96;

export interface ScrollMetrics {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

/** Keep the same visible content after older rows increase scrollHeight. */
export function anchoredScrollTop(scrollTop: number, previousScrollHeight: number, nextScrollHeight: number): number {
  return Math.max(0, scrollTop + nextScrollHeight - previousScrollHeight);
}

/** Whether content growth should continue following the end of the transcript. */
export function isNearTranscriptBottom(
  metrics: ScrollMetrics,
  threshold = TRANSCRIPT_BOTTOM_THRESHOLD,
): boolean {
  return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= threshold;
}

interface NearestScrollMetrics {
  scrollTop: number;
  viewportTop: number;
  viewportBottom: number;
  itemTop: number;
  itemBottom: number;
}

/**
 * Compute a scroll position without asking scrollIntoView to move page-level
 * ancestors. Coordinates are viewport-relative and the result is local to the
 * transcript scroller.
 */
export function nearestTranscriptScrollTop(
  metrics: NearestScrollMetrics,
  margin = 16,
): number {
  const visibleTop = metrics.viewportTop + margin;
  const visibleBottom = metrics.viewportBottom - margin;

  if (metrics.itemTop < visibleTop) {
    return Math.max(0, metrics.scrollTop + metrics.itemTop - visibleTop);
  }
  if (metrics.itemBottom > visibleBottom) {
    return Math.max(0, metrics.scrollTop + metrics.itemBottom - visibleBottom);
  }
  return metrics.scrollTop;
}
