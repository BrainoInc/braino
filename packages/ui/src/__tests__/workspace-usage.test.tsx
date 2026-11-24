import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { WorkspaceUsagePage } from "../workspace-usage.js";

it("shows both windows, keeps retained storage separate and localizes numbers", () => {
  const period = { queries: 12000, replies: 42, ingestedTokens: 700, averageStoredBytes: 1500 };
  const html = renderToStaticMarkup(
    <WorkspaceUsagePage
      breadcrumb={<a href="/">Acme</a>}
      locale="de"
      labels={{
        title: "Nutzung",
        metric: "Metrik",
        month: "Dieser Monat (UTC)",
        fiveHours: "Letzte 5 Stunden",
        queries: "Abfragen",
        replies: "Antworten",
        tokens: "Geschätzte Aufnahmetoken",
        averageStorage: "Durchschnittlicher Speicher",
        currentStorage: "Aktueller Speicher",
        updated: "Stand",
      }}
      report={{
        month: period,
        fiveHours: { ...period, queries: 0 },
        storedBytes: 5000,
        asOf: "2026-12-01T02:00:00.000Z",
      }}
    />,
  );
  for (const value of [
    "Dieser Monat (UTC)",
    "Letzte 5 Stunden",
    "12.000",
    "1,5",
    "Aktueller Speicher",
    'scope="row"',
    'dateTime="2026-12-01T02:00:00.000Z"',
  ])
    expect(html).toContain(value);
});
