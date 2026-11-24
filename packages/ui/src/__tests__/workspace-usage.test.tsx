// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { WorkspaceUsagePage } from "../workspace-usage.js";

const monthly = {
  writes: 18,
  imports: 7,
  searchedTokens: 200,
  queries: 12000,
  replies: 42,
  ingestedTokens: 700,
};
const recent = {
  writes: 2,
  imports: 1,
  searchedTokens: 12,
  queries: 0,
  replies: 2,
  ingestedTokens: 18,
};
const end = "2026-12-01T02:00:00.000Z";
const changeMember = vi.fn();
const page = (
  <WorkspaceUsagePage
    breadcrumb={<a href="/">Acme</a>}
    onMemberChange={changeMember}
    locale="de"
    labels={{
      title: "Nutzung",
      teamMember: "Teammitglied",
      allMembers: "Alle Mitglieder",
      workspaceStorage: "Speicher des Arbeitsbereichs",
      attribution: "Nur zugeordnete Aktivitäten.",
      timeRange: "Zeitraum",
      daily: "Täglich",
      quarterHourly: "15-Minuten-Intervalle",
      month: "Dieser Monat (UTC)",
      fiveHours: "Letzte 5 Stunden",
      queries: "Abfragen",
      writes: "Änderungen",
      imports: "Importe",
      workspaceImports: "Importe im Arbeitsbereich",
      searchedTokens: "Durchsuchte Token",
      replies: "Antworten von Señor Braino",
      ingestedTokens: "Ingestierte Token",
      storedBytes: "Belegter Speicher",
      searchDescription: "Durchsuchter Text.",
      ingestionDescription: "Ein Token pro vier Zeichen, pro Textrevision aufgerundet.",
      storageDescription: "Gespeicherter Quelltext am Ende jedes Intervalls.",
      updated: "Stand",
    }}
    report={{
      members: [{ id: "m1", name: "Sam" }],
      memberId: null,
      month: {
        ...monthly,
        buckets: [{ ...monthly, storedBytes: 5000, start: "2026-12-01T00:00:00.000Z", end }],
      },
      fiveHours: {
        ...recent,
        buckets: [{ ...recent, storedBytes: 5000, start: "2026-12-01T01:45:00.000Z", end }],
      },
      storedBytes: 5000,
      asOf: end,
    }}
  />
);

it("renders all seven metrics for this month on the first response", () => {
  const html = renderToStaticMarkup(page);
  expect(html.match(/<figure\b/g)).toHaveLength(7);
  for (const text of [
    "Abfragen",
    "Änderungen",
    "Importe",
    "Durchsuchte Token",
    "Antworten von Señor Braino",
    "Ingestierte Token",
    "Belegter Speicher",
  ]) {
    expect(html).toContain(`${text}</h2>`);
  }
  expect(html).toContain("12.000");
  expect(html).toContain("Ein Token pro vier Zeichen, pro Textrevision aufgerundet.");
  expect(html).toContain("Gespeicherter Quelltext am Ende jedes Intervalls.");
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
    const select = container.querySelector("select");
    if (!select) throw new Error("Missing member filter");
    expect(Array.from(select.options, (o) => o.textContent)).toEqual(["Alle Mitglieder", "Sam"]);
    await act(async () => {
      select.value = "m1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(changeMember).toHaveBeenCalledWith("m1");
    const initial = totals();
    expect(initial[6]).toMatch(/5.*kB/i);
    expect(initial.slice(0, 6)).toEqual(["12.000", "200", "18", "7", "42", "700"]);
    await act(async () => fiveHours?.click());
    expect(fiveHours?.checked).toBe(true);
    expect(totals().slice(0, 6)).toEqual(["0", "12", "2", "1", "2", "18"]);
    expect(totals()[6]).toBe(initial[6]);
    expect(container.textContent).toContain("15-Minuten-Intervalle");
    await act(async () => month?.click());
    expect(totals()).toEqual(initial);
    expect(container.textContent).toContain("Täglich");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
