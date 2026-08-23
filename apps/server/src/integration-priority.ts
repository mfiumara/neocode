export interface IntegrationComplexityInput {
  files: number;
  additions: number;
  deletions: number;
  overlappingFiles: number;
  ageMs: number;
}

/** Lower scores enter bounded review lanes first; aging prevents starvation. */
export function integrationComplexityScore(input: IntegrationComplexityInput): number {
  const raw = input.additions + input.deletions + input.files * 20 + input.overlappingFiles * 250;
  const ageCredit = Math.floor(Math.max(0, input.ageMs) / 3_600_000) * 2;
  return Math.max(0, raw - ageCredit);
}
