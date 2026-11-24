export interface UsagePeriodTotals {
  queries: number;
  replies: number;
  ingestedTokens: number;
}

export interface WorkspaceUsagePeriod extends UsagePeriodTotals {
  buckets: (UsagePeriodTotals & { start: string; end: string; storedBytes: number })[];
}

export interface WorkspaceUsageReport {
  asOf: string;
  storedBytes: number;
  month: WorkspaceUsagePeriod;
  fiveHours: WorkspaceUsagePeriod;
}
