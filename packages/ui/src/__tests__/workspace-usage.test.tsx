// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { WorkspaceUsagePage } from "../workspace-usage.js";

const monthly = { queries: 12000, replies: 42, ingestedTokens: 700, averageStoredBytes: 1500 };
const recent = { queries: 0, replies: 2, ingestedTokens: 18, averageStoredBytes: 500 };
const end = "2026-12-01T02:00:00.000Z";
const page = (
  <WorkspaceUsagePage
    breadcrumb={<a href="/">Acme</a>}
    locale="de"
    labels={{
      title: "Nutzung",
      timeRange: "Zeitraum",
      daily: "Täglich",
      quarterHourly: "15-Minuten-Intervalle",
      month: "Dieser Monat (UTC)",
      fiveHours: "Letzte 5 Stunden",
      queries: "Abfragen",
      replies: "Antworten",
      ingestedTokens: "Geschätzte Aufnahmetoken",
      averageStoredBytes: "Durchschnittlicher Speicher",
      currentStorage: "Aktueller Speicher",
      updated: "Stand",
    }}
    report={{
      month: { ...monthly, buckets: [{ ...monthly, start: "2026-12-01T00:00:00.000Z", end }] },
      fiveHours: { ...recent, buckets: [{ ...recent, start: "2026-12-01T01:45:00.000Z", end }] },
      storedBytes: 5000,
      asOf: end,
    }}
  />
);

it("renders all four metrics for this month on the first response", () => {
  const html = renderToStaticMarkup(page);
  expect(html.match(/<figure\b/g)).toHaveLength(4);
  for (const text of [
    "Abfragen",
    "Antworten",
    "Geschätzte Aufnahmetoken",
    "Durchschnittlicher Speicher",
  ]) {
    expect(html).toContain(`${text}</h2>`);
  }
  expect(html).toContain("12.000");
  expect(html).toContain("Aktueller Speicher");
  expect(html).toContain(`dateTime="${end}"`);
});

it("changes every graph with one time filter and keeps current storage fixed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const totals = () =>
    Array.from(container.querySelectorAll("figcaption strong"), (el) => el.textContent);
  try {
    await act(async () => root.render(page));
    const [month, fiveHours] = container.querySelectorAll<HTMLInputElement>(
      "fieldset input[type=radio]",
    );
    expect(month?.checked).toBe(true);
    expect(fiveHours?.checked).toBe(false);
    const initial = totals();
    const storage = container.querySelector("dd")?.textContent;
    expect(initial.slice(0, 3)).toEqual(["12.000", "42", "700"]);
    await act(async () => fiveHours?.click());
    expect(fiveHours?.checked).toBe(true);
    expect(totals().slice(0, 3)).toEqual(["0", "2", "18"]);
    expect(totals()[3]).not.toBe(initial[3]);
    expect(container.textContent).toContain("15-Minuten-Intervalle");
    expect(container.querySelector("dd")?.textContent).toBe(storage);
    await act(async () => month?.click());
    expect(totals()).toEqual(initial);
    expect(container.textContent).toContain("Täglich");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
