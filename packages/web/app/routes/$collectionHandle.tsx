import { withClient } from "@braino/db";
import { ChangesetError, applyChangeset } from "@braino/host";
import { CAPTURE_SCHEMAS } from "@braino/shared";
import { useT } from "@braino/shared/i18n/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@braino/ui";
import { PageHeader } from "@braino/ui";
import { PageMain } from "@braino/ui";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import { getCollectionForUser } from "~/lib/collection-access.server.js";
import { getCurrentUser } from "~/lib/current-user.server.js";
import { requestTranslator } from "~/locales/catalog";

interface CollectionNode {
  id: string;
  node_type: string;
  title: string;
  lifecycle: string;
  updated_at: string;
}

export async function loader({
  request,
  params,
}: { request: Request; params: { collectionHandle?: string } }) {
  const user = await getCurrentUser(request);
  if (!user) throw redirect("/");
  const collection = await getCollectionForUser(params.collectionHandle ?? "", user.id);
  if (!collection) throw new Response("Collection not found", { status: 404 });
  if (collection.template_handle === "codebase") {
    throw redirect(`/${collection.handle}/code`);
  }
  const data = await withClient(async (client) => {
    const nodes = await client.query<CollectionNode>(
      `SELECT id, node_type,
              coalesce(nullif(extra->>'title', ''), nullif(extra->>'name', ''),
                       nullif(split_part(prose, E'\n', 1), ''), id) AS title,
              lifecycle, updated_at::text
         FROM nodes
        WHERE collection_id = $1
        ORDER BY updated_at DESC
        LIMIT 100`,
      [collection.id],
    );
    return {
      collection,
      nodes: nodes.rows,
      nodeTypes: Object.values(CAPTURE_SCHEMAS).map((schema) => ({
        value: schema.nodeType,
        label: schema.label,
      })),
    };
  });
  return data;
}

function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { collectionHandle?: string };
}) {
  const user = await getCurrentUser(request);
  if (!user) throw redirect("/");
  const t = await requestTranslator(request);
  const form = await request.formData();
  if (formText(form, "intent") !== "create") {
    return Response.json({ error: t("Unknown action.") }, { status: 400 });
  }
  let extra: Record<string, unknown> = {};
  const details = formText(form, "details");
  if (details) {
    try {
      const parsed = JSON.parse(details) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return Response.json({ error: t("Details must be a JSON object.") }, { status: 400 });
      }
      extra = parsed as Record<string, unknown>;
    } catch {
      return Response.json({ error: t("Details must be valid JSON.") }, { status: 400 });
    }
  }
  try {
    const result = await withClient((client) =>
      applyChangeset(client, {
        collectionHandle: params.collectionHandle ?? "",
        actorId: user.id,
        source: "ui",
        reason: "Created from the collection page",
        metadata: { route: "collection" },
        operations: [
          {
            op: "create",
            node_type: formText(form, "node_type"),
            body: {
              prose: formText(form, "prose"),
              ...(formText(form, "lifecycle") ? { lifecycle: formText(form, "lifecycle") } : {}),
              extra,
            },
          },
        ],
      }),
    );
    return redirect(`/${params.collectionHandle}?created=${result.results[0]?.id ?? ""}`);
  } catch (error) {
    if (error instanceof ChangesetError) {
      return Response.json({ error: t(error.message) }, { status: error.status });
    }
    throw error;
  }
}

export default function CollectionPage() {
  const data = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  const actionData = useActionData() as { error?: string } | undefined;
  const t = useT();
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader
        breadcrumb={
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <Link to="/" className="hover:underline">
              {"Braino"}
            </Link>
            <span aria-hidden>›</span>
            <span>{t("Collection")}</span>
          </nav>
        }
        title={data.collection.handle}
      >
        <p className="max-w-3xl text-sm text-muted-foreground">{data.collection.goal}</p>
      </PageHeader>
      <Card>
        <CardHeader>
          <CardTitle>{t("New record")}</CardTitle>
          <CardDescription>
            {t(
              "Capture a record here or use the collection changeset API. Both paths keep the same immutable history and audit trail.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="create" />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">{t("Record type")}</span>
                <select name="node_type" className="w-full rounded-md px-3 py-2 text-sm">
                  {data.nodeTypes.map((nodeType) => (
                    <option key={nodeType.value} value={nodeType.value}>
                      {t(nodeType.label)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">{t("Lifecycle")}</span>
                <select name="lifecycle" className="w-full rounded-md px-3 py-2 text-sm">
                  <option value="">{t("Collection default")}</option>
                  <option value="drafting">{t("Drafting")}</option>
                  <option value="queued">{t("Queued")}</option>
                  <option value="active">{t("Active")}</option>
                  <option value="retired">{t("Retired")}</option>
                </select>
              </label>
            </div>
            <label className="block text-xs">
              <span className="mb-1 block text-muted-foreground">{t("Prose")}</span>
              <textarea
                name="prose"
                required
                rows={5}
                placeholder={t("First line: a clear label. Continue with the full context.")}
                className="w-full rounded-md px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block text-muted-foreground">
                {t("Details (optional JSON)")}
              </span>
              <textarea
                name="details"
                rows={3}
                placeholder={`{ "question": ${JSON.stringify(t("What are we deciding?"))} }`}
                className="w-full rounded-md px-3 py-2 font-mono text-xs"
              />
            </label>
            {actionData?.error ? (
              <p role="alert" className="text-xs text-destructive">
                {actionData.error}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                {t("Capture record")}
              </button>
              <Link
                to={`/${data.collection.handle}/api/authoring-contract.json`}
                className="font-mono text-[11px] hover:underline"
              >
                {t("Authoring contract")}
              </Link>
            </div>
          </Form>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <h2 className="text-sm font-semibold">{t("Recent records")}</h2>
          {data.nodes.length ? (
            <ul className="mt-3 divide-y divide-border">
              {data.nodes.map((node) => (
                <li className="py-3 first:pt-0 last:pb-0" key={node.id}>
                  <strong className="text-sm">{node.title}</strong>
                  <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {node.node_type} · {node.lifecycle}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs italic text-muted-foreground">
              {t("This collection has no records yet.")}
            </p>
          )}
        </CardContent>
      </Card>
    </PageMain>
  );
}
