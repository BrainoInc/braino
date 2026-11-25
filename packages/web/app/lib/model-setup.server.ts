import { withClient } from "@braino/db";
import {
  getSingleWorkspaceState,
  getWorkspaceRole,
  pluginHostConnectionFromEnv,
} from "@braino/host";
import type { PluginHostConnection } from "@braino/host";
import {
  getWorkspaceModelPluginReadiness,
  listWorkspaceModelPlugins,
} from "@braino/host/model-plugins";
import { redirect } from "react-router";
import { bundledModelPluginCatalog } from "~/lib/bundled-model-plugins.server";
import { getCurrentUser } from "~/lib/current-user.server";
import {
  type InstalledModelPlugin,
  MODEL_CAPABILITY,
  MODEL_KINDS,
  type ModelPluginEntry,
  type ModelStep,
  modelSteps,
} from "~/lib/model-plugin-catalog";

export interface ModelSetup {
  workspace: { id: string; handle: string; name: string };
  userId: string;
  isOwner: boolean;
  ready: boolean;
  catalog: ModelPluginEntry[];
  installed: InstalledModelPlugin[];
  steps: ModelStep[];
}

/**
 * The state every model setup screen starts from. Sends a visitor without a
 * session or a workspace home. Only an owner sees which plugins are installed.
 */
export async function loadModelSetup(request: Request): Promise<ModelSetup> {
  const user = await getCurrentUser(request);
  if (!user) throw redirect("/");
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) throw redirect("/");
  const workspaceId = state.workspace.id;
  const loaded = await withClient(async (client) => {
    const readiness = await getWorkspaceModelPluginReadiness(client, workspaceId);
    // Home sends everyone here until the models are ready, so nobody is sent back from here.
    if ((await getWorkspaceRole(client, workspaceId, user.id)) !== "owner") {
      return { readiness, isOwner: false, installed: [] };
    }
    const installed: InstalledModelPlugin[] = (
      await listWorkspaceModelPlugins(client, workspaceId)
    ).map((plugin) => ({
      installationId: plugin.installationId,
      pluginId: plugin.pluginId,
      name: plugin.name,
      kind: plugin.capability === MODEL_CAPABILITY.chat ? "chat" : "embedding",
      active: plugin.active,
      verified: plugin.verified,
      configuration: plugin.configuration,
      secretNames: plugin.secretNames,
    }));
    return { readiness, isOwner: true, installed };
  });
  const catalog = loaded.isOwner ? await bundledModelPluginCatalog() : [];
  return {
    workspace: state.workspace,
    userId: user.id,
    isOwner: loaded.isOwner,
    ready: loaded.readiness.ready,
    catalog,
    installed: loaded.installed,
    steps: modelSteps(loaded.readiness, catalog, loaded.installed),
  };
}

/** The key that seals plugin secrets, or null when the deployment has not set a usable one. */
export function pluginSecretsKey(): string | null {
  const value = process.env.DOCO_ENCRYPTION_KEY?.trim();
  return value && value.length >= 32 ? value : null;
}

/** The private WASI runner used for every workspace-scoped plugin invocation. */
export function pluginHostConnection(): PluginHostConnection | null {
  return pluginHostConnectionFromEnv(process.env);
}
