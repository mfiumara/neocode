export interface ThreadNavigationState {
  selectedRow: number;
  scrollTop: number;
}

export type ThreadNavigationByView = Record<string, ThreadNavigationState>;

export function lastRow(rowCount: number): number {
  return Math.max(0, rowCount - 1);
}

export function clampRow(row: number, rowCount: number): number {
  if (rowCount <= 0) return 0;
  return Math.min(Math.max(0, row), rowCount - 1);
}

/** A thread that has not been visited starts at its newest row. */
export function navigationForView(
  navigation: ThreadNavigationByView,
  viewKey: string,
  rowCount: number,
): ThreadNavigationState {
  const saved = navigation[viewKey];
  if (!saved) return { selectedRow: lastRow(rowCount), scrollTop: 0 };
  return { ...saved, selectedRow: clampRow(saved.selectedRow, rowCount) };
}
