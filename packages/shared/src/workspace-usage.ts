export interface UsagePeriodTotals {
  queries: number;
  replies: number;
  ingestedTokens: number;
  averageStoredBytes: number;
}

export interface WorkspaceUsagePeriod extends UsagePeriodTotals {
  buckets: (UsagePeriodTotals & { start: string; end: string })[];
}

export interface WorkspaceUsageReport {
  asOf: string;
  storedBytes: number;
  month: WorkspaceUsagePeriod;
  fiveHours: WorkspaceUsagePeriod;
}
