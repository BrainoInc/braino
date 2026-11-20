import type { ReactTranslator } from "@doco/shared/i18n/react";

const ITEMS: Record<string, [string, string]> = {
  "agents-chats": ["chat", "chats"],
  "architectural-decisions": ["decision", "decisions"],
  "design-decisions": ["decision", "decisions"],
  "product-decisions": ["decision", "decisions"],
  "security-decisions": ["decision", "decisions"],
  "github-issues": ["issue", "issues"],
  "github-pull-requests": ["pull request", "pull requests"],
  glossary: ["term", "terms"],
  ideas: ["idea", "ideas"],
  process: ["process", "processes"],
  slack: ["message", "messages"],
};

export function countCollectionItems(
  t: ReactTranslator,
  count: number,
  template: string | null,
): string {
  const [one, many] = ITEMS[template ?? ""] ?? ["record", "records"];
  return `${count.toLocaleString(t.locale)} ${count === 1 ? one : many}`;
}
