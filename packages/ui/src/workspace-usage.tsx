import type { WorkspaceUsagePeriod, WorkspaceUsageReport } from "@doco/shared";
import { type ReactNode, useId, useState } from "react";
import { Card } from "./card.js";
import { PageHeader, PageMain } from "./page.js";

interface UsageLabels {
  title: string;
  metric: string;
  month: string;
  daily: string;
  quarterHourly: string;
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

const metrics = {
  queries: "queries",
  replies: "replies",
  ingestedTokens: "tokens",
  averageStoredBytes: "averageStorage",
} as const;
type Metric = keyof typeof metrics;

function UsageChart({
  period,
  title,
  cadence,
  daily,
  metric,
  metricName,
  locale,
}: {
  period: WorkspaceUsagePeriod;
  title: string;
  cadence: string;
  daily: boolean;
  metric: Metric;
  metricName: string;
  locale: string;
}) {
  const captionId = useId();
  const [selected, setSelected] = useState<number | null>(null);
  const { buckets } = period;
  const index = Math.min(selected ?? buckets.length - 1, buckets.length - 1);
  const active = buckets[index];
  const count = new Intl.NumberFormat(locale);
  const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
  const format = (v: number) =>
    metric === "averageStoredBytes" ? formatBytes(v, locale) : count.format(v);
  const formatAxis = (v: number) =>
    metric === "averageStoredBytes" ? formatBytes(v, locale) : compact.format(v);
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" });
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    hourCycle: "h23",
  });
  const timeWithZone = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
    hourCycle: "h23",
  });
  const range = (bucket: WorkspaceUsagePeriod["buckets"][number]) => {
    const start = new Date(bucket.start);
    if (daily) return date.format(start);
    return `${date.format(start)} · ${timeWithZone.formatRange(start, new Date(bucket.end))}`;
  };
  const peak = Math.max(1, ...buckets.map((bucket) => bucket[metric]));
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const ceiling = ([1, 2, 4, 10].find((step) => step * magnitude >= peak) ?? 10) * magnitude;
  const ticks = ceiling === 1 ? [1, 0] : [ceiling, ceiling / 2, 0];
  const xTick = (iso: string) => (daily ? date : time).format(new Date(iso));
  const first = buckets[0];
  const last = buckets.at(-1);

  return (
    <figure aria-labelledby={captionId} className="min-w-0 space-y-5">
      <figcaption id={captionId} className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-base font-semibold">{title}</h2>
          <span className="text-xs text-muted-foreground">{cadence}</span>
        </div>
        <p className="flex flex-wrap items-baseline gap-x-2">
          <strong className="font-mono text-3xl font-semibold tabular-nums">
            {format(period[metric])}
          </strong>
          <span className="text-sm text-muted-foreground">{metricName}</span>
        </p>
      </figcaption>
      <div
        dir="ltr"
        className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-2 text-[11px] text-muted-foreground"
      >
        <div
          aria-hidden="true"
          className="flex h-36 flex-col justify-between text-end font-mono leading-none"
        >
          {ticks.map((tick) => (
            <span key={tick}>{formatAxis(tick)}</span>
          ))}
        </div>
        <div className="relative h-36">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex flex-col justify-between"
          >
            {ticks.map((tick) => (
              <div key={tick} className="border-t border-border" />
            ))}
          </div>
          <div className="relative flex h-full">
            {buckets.map((bucket, i) => (
              <button
                key={bucket.start}
                type="button"
                aria-pressed={i === index}
                aria-label={`${range(bucket)} · ${format(bucket[metric])} ${metricName}`}
                tabIndex={i === index ? 0 : -1}
                className="group flex h-full min-w-0 flex-1 cursor-pointer items-end justify-center bg-transparent p-0 shadow-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                onPointerEnter={() => setSelected(i)}
                onFocus={() => setSelected(i)}
                onClick={() => setSelected(i)}
                onKeyDown={(event) => {
                  let next: number;
                  switch (event.key) {
                    case "ArrowLeft":
                      next = Math.max(0, i - 1);
                      break;
                    case "ArrowRight":
                      next = Math.min(buckets.length - 1, i + 1);
                      break;
                    case "Home":
                      next = 0;
                      break;
                    case "End":
                      next = buckets.length - 1;
                      break;
                    default:
                      return;
                  }
                  event.preventDefault();
                  const target = event.currentTarget.parentElement?.children[next];
                  if (target instanceof HTMLElement) target.focus();
                }}
              >
                <span
                  aria-hidden="true"
                  className="block w-4/5 max-w-12 rounded-t-sm bg-primary opacity-65 group-aria-pressed:opacity-100"
                  style={{ height: `${(100 * bucket[metric]) / ceiling}%` }}
                />
              </button>
            ))}
          </div>
        </div>
        <div aria-hidden="true" className="col-start-2 flex justify-between font-mono">
          {first && <span>{xTick(first.start)}</span>}
          {last && (!daily || last !== first) && (
            <span>{xTick(daily ? last.start : last.end)}</span>
          )}
        </div>
      </div>
      {active && (
        <p className="flex flex-wrap items-baseline justify-between gap-x-2 border-t border-border pt-3 text-xs">
          <span className="text-muted-foreground">{range(active)}</span>
          <strong className="font-mono font-semibold tabular-nums">{format(active[metric])}</strong>
        </p>
      )}
    </figure>
  );
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
  const [metric, setMetric] = useState<Metric>("queries");
  const stamp = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader title={labels.title} breadcrumb={breadcrumb}>
        <p className="text-xs text-muted-foreground">
          {labels.updated} <time dateTime={report.asOf}>{stamp.format(new Date(report.asOf))}</time>
        </p>
      </PageHeader>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {labels.metric}
          <select
            className="rounded-md px-3 py-2 text-sm font-medium text-foreground"
            value={metric}
            onChange={(event) => setMetric(event.target.value as Metric)}
          >
            {Object.entries(metrics).map(([key, label]) => (
              <option key={key} value={key}>
                {labels[label]}
              </option>
            ))}
          </select>
        </label>
        <dl className="text-end">
          <dt className="text-xs text-muted-foreground">{labels.currentStorage}</dt>
          <dd className="font-mono font-semibold tabular-nums">
            {formatBytes(report.storedBytes, locale)}
          </dd>
        </dl>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,24rem),1fr))] gap-5">
        <Card className="min-w-0 p-4 sm:p-6">
          <UsageChart
            period={report.month}
            title={labels.month}
            cadence={labels.daily}
            daily
            metric={metric}
            metricName={labels[metrics[metric]]}
            locale={locale}
          />
        </Card>
        <Card className="min-w-0 p-4 sm:p-6">
          <UsageChart
            period={report.fiveHours}
            title={labels.fiveHours}
            cadence={labels.quarterHourly}
            daily={false}
            metric={metric}
            metricName={labels[metrics[metric]]}
            locale={locale}
          />
        </Card>
      </div>
    </PageMain>
  );
}
