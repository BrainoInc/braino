export interface UsagePeriodTotals {
  queries: number;
  replies: number;
  ingestedTokens: number;
  averageStoredBytes: number;
}

export interface WorkspaceUsageReport {
  asOf: string;
  storedBytes: number;
  month: UsagePeriodTotals;
  fiveHours: UsagePeriodTotals;
}
