import type { WorkspaceUsageReport } from "@doco/shared";
import type { ReactNode } from "react";
import { Card } from "./card.js";
import { PageHeader, PageMain } from "./page.js";

interface UsageLabels {
  title: string;
  metric: string;
  month: string;
  fiveHours: string;
  queries: string;
  replies: string;
  tokens: string;
  averageStorage: string;
  currentStorage: string;
  updated: string;
}

function formatBytes(value: number, locale: string): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte", "petabyte"];
  const index = value < 1 ? 0 : Math.min(units.length - 1, Math.floor(Math.log10(value) / 3));
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[index],
    unitDisplay: "short",
    maximumFractionDigits: index === 0 ? 0 : 2,
  }).format(value / 1000 ** index);
}

export function WorkspaceUsagePage({
  report,
  labels,
  locale,
  breadcrumb,
}: {
  report: WorkspaceUsageReport;
  labels: UsageLabels;
  locale: string;
  breadcrumb: ReactNode;
}) {
  const count = new Intl.NumberFormat(locale);
  const stamp = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
  const { month, fiveHours } = report;
  const rows = [
    [labels.queries, count.format(month.queries), count.format(fiveHours.queries)],
    [labels.replies, count.format(month.replies), count.format(fiveHours.replies)],
    [labels.tokens, count.format(month.ingestedTokens), count.format(fiveHours.ingestedTokens)],
    [
      labels.averageStorage,
      formatBytes(month.averageStoredBytes, locale),
      formatBytes(fiveHours.averageStoredBytes, locale),
    ],
  ];

  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader title={labels.title} breadcrumb={breadcrumb}>
        <p className="text-xs text-muted-foreground">
          {labels.updated} <time dateTime={report.asOf}>{stamp.format(new Date(report.asOf))}</time>
        </p>
      </PageHeader>
      <Card className="overflow-x-auto">
        <table aria-label={labels.title} className="w-full border-collapse text-sm">
          <thead className="border-b border-border bg-muted/40">
            <tr>
              <th scope="col" className="px-3 py-4 text-start font-medium sm:px-6">
                {labels.metric}
              </th>
              <th scope="col" className="px-2 py-4 text-end font-semibold sm:px-6">
                {labels.month}
              </th>
              <th scope="col" className="px-2 py-4 text-end font-semibold sm:px-6">
                {labels.fiveHours}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, monthValue, fiveHourValue]) => (
              <tr key={label} className="border-b border-border last:border-0">
                <th scope="row" className="px-3 py-4 text-start font-medium sm:px-6">
                  {label}
                </th>
                <td className="px-2 py-4 text-end font-mono tabular-nums sm:px-6">{monthValue}</td>
                <td className="px-2 py-4 text-end font-mono tabular-nums sm:px-6">
                  {fiveHourValue}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <dl className="flex items-baseline gap-3">
        <dt className="text-sm text-muted-foreground">{labels.currentStorage}</dt>
        <dd className="font-mono font-semibold tabular-nums">
          {formatBytes(report.storedBytes, locale)}
        </dd>
      </dl>
    </PageMain>
  );
}
