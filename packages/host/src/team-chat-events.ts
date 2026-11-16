import type { PoolClient } from "@doco/db";
import type { PluginEvent, TeamChatMessage, TeamChatSendResponse } from "@doco/plugin-runtime";
import { generateUlid } from "@doco/shared";

interface DeliveryRow {
  id: string;
  workspace_id: string;
  installation_id: string;
  actor_user_id: string | null;
  kind: string;
  data: unknown;
}

export interface TeamChatEventDependencies {
  answer(input: { workspaceId: string; userId: string; question: string }): Promise<string>;
  send(input: {
    workspaceId: string;
    installationId: string;
    message: TeamChatMessage;
  }): Promise<TeamChatSendResponse>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is invalid.`);
  return value.trim();
}

/** Persist canonical team-chat events before acknowledging the provider. */
export async function enqueueTeamChatEvents(
  client: PoolClient,
  input: {
    workspaceId: string;
    installationId: string;
    events: readonly PluginEvent[];
  },
): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;
  for (const event of input.events) {
    if (event.kind !== "team_chat.message" && event.kind !== "team_chat.uninstalled") continue;
    let data = { ...event.data };
    let actorUserId: string | null = null;
    if (event.kind === "team_chat.message") {
      const senderEmail = requiredText(data.senderEmail, "Team chat sender email").toLowerCase();
      const { senderEmail: _senderEmail, ...storedData } = data;
      data = storedData;
      const actor = await client.query<{ id: string }>(
        `SELECT u.id
           FROM users u
           JOIN workspace_users wu ON wu.user_id = u.id AND wu.workspace_id = $1
          WHERE lower(u.email) = $2 AND u.deactivated_at IS NULL
          LIMIT 1`,
        [input.workspaceId, senderEmail],
      );
      actorUserId = actor.rows[0]?.id ?? null;
    }
    const inserted = await client.query(
      `INSERT INTO plugin_event_deliveries
         (id, workspace_id, installation_id, actor_user_id, external_id, kind, occurred_at, data)
       SELECT $1, $2, $3, $4, $5, $6, $7::timestamptz, $8::jsonb
        WHERE EXISTS (
          SELECT 1 FROM plugin_installations
           WHERE id = $3 AND workspace_id = $2 AND enabled
        )
       ON CONFLICT (installation_id, external_id) DO NOTHING
       RETURNING id`,
      [
        `plugin_event_${generateUlid()}`,
        input.workspaceId,
        input.installationId,
        actorUserId,
        event.id,
        event.kind,
        event.occurredAt,
        JSON.stringify(data),
      ],
    );
    if (inserted.rows.length > 0) created += 1;
    else skipped += 1;
  }
  return { created, skipped };
}

async function claim(client: PoolClient): Promise<DeliveryRow | null> {
  const found = await client.query<DeliveryRow>(
    `WITH candidate AS (
       SELECT id
         FROM plugin_event_deliveries
        WHERE processed_at IS NULL
          AND available_at <= now()
          AND (locked_at IS NULL OR locked_at < now() - interval '5 minutes')
        ORDER BY available_at, created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE plugin_event_deliveries d
        SET locked_at = now(), attempts = attempts + 1, last_error = NULL
       FROM candidate, plugin_installations i
      WHERE d.id = candidate.id
        AND i.id = d.installation_id
        AND i.workspace_id = d.workspace_id
        AND i.enabled
      RETURNING d.id, d.workspace_id, d.installation_id, d.actor_user_id,
                d.kind, d.data`,
  );
  return found.rows[0] ?? null;
}

/** Drain one delivery. A scheduler loop supplies the model and outbound plugin. */
export async function processNextTeamChatEvent(
  client: PoolClient,
  dependencies: TeamChatEventDependencies,
): Promise<"empty" | "processed" | "failed"> {
  const delivery = await claim(client);
  if (!delivery) return "empty";
  try {
    if (delivery.kind === "team_chat.uninstalled") {
      await client.query(
        `UPDATE plugin_installations
            SET enabled = false, updated_at = now()
          WHERE id = $1 AND workspace_id = $2`,
        [delivery.installation_id, delivery.workspace_id],
      );
    } else {
      const data = object(delivery.data);
      const answer = delivery.actor_user_id
        ? await dependencies.answer({
            workspaceId: delivery.workspace_id,
            userId: delivery.actor_user_id,
            question: requiredText(data.text, "Team chat message text"),
          })
        : "Your Slack email is not a member of this Braino workspace.";
      const threadId =
        typeof data.replyThreadId === "string" && data.replyThreadId.trim()
          ? data.replyThreadId.trim()
          : undefined;
      await dependencies.send({
        workspaceId: delivery.workspace_id,
        installationId: delivery.installation_id,
        message: {
          target: { kind: "channel", id: requiredText(data.channelId, "Team chat channel") },
          text: answer,
          ...(threadId ? { threadId } : {}),
        },
      });
    }
    await client.query(
      `UPDATE plugin_event_deliveries
          SET processed_at = now(), locked_at = NULL, last_error = NULL
        WHERE id = $1`,
      [delivery.id],
    );
    return "processed";
  } catch {
    await client.query(
      `UPDATE plugin_event_deliveries
          SET locked_at = NULL,
              last_error = 'delivery_failed',
              available_at = now() + LEAST(attempts, 60) * interval '1 second'
        WHERE id = $1`,
      [delivery.id],
    );
    return "failed";
  }
}
