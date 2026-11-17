# Braino

Braino is an open knowledge system for durable decisions, rules, evidence, and
their relationships. This repository is the sole upstream for the open product.

This tree contains the supported single-workspace, self-hosted product:

- `@doco/shared` — entity types, identifiers, policies, and URL conventions
- `@doco/plugin-runtime` — versioned manifests and capability contracts for plugins
- `@doco/db` — PostgreSQL schema and source-of-truth storage
- `@doco/host` — workspace, collection, person, and template services
- `@doco/index` — retrieval, ranking, embeddings, and Qdrant integration
- `@doco/web` — first-run setup, owner sign-in, workspace home, collection reader, and record authoring

A release is cut when a version bump merges to main. Each one publishes the
reusable packages above plus `@doco/connector-plugins` as immutable tarball
assets beside the application image. Hosted Braino consumes those assets instead of carrying a second copy of
the core implementation.

The supported deployment is one application image running the web process and
the Braino Times scheduler, one stateless CodeLinker service, one stateless
Wasmtime plugin host, one PostgreSQL source of truth, and one rebuildable Qdrant index. Core authoring, team access,
deterministic search, Braino Times, MCP, generic webhooks, GitHub import, and
operations work without a model provider.

## Self-hosting

```sh
cp .env.example .env
# Fill all five secrets in .env with independent `openssl rand -base64 32` values.
docker compose up -d --build
curl --fail http://localhost:3000/healthz
```

`BRAINO_SETUP_TOKEN` is a per-deployment bootstrap secret, not a default
embedded in the image or a Braino Cloud credential. Generate it yourself—or
have deployment automation generate it—and keep it in the deployment's private
environment; the Docker path above stores it in the host's uncommitted `.env`.
It prevents the first visitor to a publicly reachable, uninitialized instance
from claiming ownership. After the sole workspace is created, first-run setup
is closed and the token cannot initialize another workspace.

Open `http://localhost:3000`, enter `BRAINO_SETUP_TOKEN`, and create the owner and
sole workspace. Braino then opens **Model setup**, which lists the two models it
needs: a chat model and an embedding model. Each comes from one plugin. The
bundled Ollama plugins are pre-selected with their default models, and the
normal Compose boot downloads both models automatically, so **Check and finish**
completes setup without choosing anything. It makes one real request through
each plugin, learns the
embedding width from the model's response, and keeps the dashboard closed if
either check fails. **Configure** on either
model lists the plugins available for it; a plugin's own page shows the one
host it may reach, a picker of suggested models, and a field for its own key
when it needs one. The application port binds to loopback; the optional Caddy
profile is the supported way to expose Braino publicly. Records
can be captured from a collection page or created, related, transitioned, and
superseded through its compatible `/<collection-handle>/api/changesets.json`
endpoint; the adjacent `api/authoring-contract.json` endpoint describes the
supported operations and shapes.

The owner opens **Admin** for the deployment overview and workspace settings,
including its name, constitution, and Braino Times publication timezone and
public visibility. The scheduler publishes at most one edition per local
calendar day; PostgreSQL keeps every edition, and signed-out readers see only
stories from public collections. The same console is the single path to
people and roles, source connections, webhooks, GitHub sync, and agent/MCP
access. It reports configuration readiness without displaying secret values;
privileged backup, restore, and upgrade commands stay on the host.

Every workspace requires one chat model plugin and one embedding model plugin;
the dashboard stays closed until both are ready. Several plugins may be
installed, but exactly one is assigned to each model, and the two are chosen
independently: chat can run on OpenAI while embeddings stay on Ollama.
**Admin → Required model plugins** leads to the same Model setup screens to
change a model, a plugin, or a key later. The default stack pulls the
`qwen3.5:2b` chat model and the 270M text-only
`embeddinggemma-2:270m` model into its own local volume. Each plugin runs as a digest-pinned WebAssembly
Component and can reach only the operator-approved `ollama:11434` service on
the private Compose network. The retrieval scheduler embeds pending source
documents and projects the resulting vectors to Qdrant; workspace content,
model input, completions, and vectors do not pass through Braino Cloud or
another Braino instance. The workspace dashboard remains unavailable until
exactly one enabled provider for each required model capability has passed its
live check.
The OpenAI chat and OpenAI embeddings plugins use the same sandbox and can reach
only `https://api.openai.com`. Each plugin holds its own API key, even when both
come from the same provider; keys are encrypted in the workspace database and
are never returned by the application.

Señor Braino and other agents connect directly to the deployment over stateless
MCP. Open **MCP** on the workspace page, copy this instance's `/mcp` URL, then
add it in ChatGPT with **Add custom MCP server** and choose OAuth. The instance
publishes its own protected-resource and authorization-server metadata, registers
public clients dynamically, requires authorization-code PKCE, rotates refresh
tokens, and binds every grant to this exact MCP resource. Its PostgreSQL database
is the only token store: credentials, MCP requests, and workspace records never
pass through Braino production or another installation.

The endpoint serves a stable profile, deterministic briefs and search, record
reads, feedback, and atomic changesets without requiring a model provider. MCP
clients that do not support OAuth can instead create a named personal access
token from the same page. All access tokens are stored only as SHA-256 digests
and remain bound to their creator's live workspace membership.

PostgreSQL and Qdrant use named volumes and are not exposed on host ports. Plain
HTTP on port 3000 is the default. For a public DNS name with automatic HTTPS,
set `DOCO_HOST` and `DOCO_PUBLIC_HOST`, then start with
`docker compose --profile tls up -d --build`.

Workspace owners can create generic incoming webhooks from **Integrations**.
POST `{"operations":[...],"reason":"..."}` to the one-time secret URL and
send a unique `Idempotency-Key` header. Deliveries use the same authoring
policies, history, permissions, and changeset response as Braino's API; retrying
the same key returns the original response without writing twice.

Owners can connect Slack, Notion, and Google Drive from the same page. They are
built-in `source.pull` plugins using the same versioned manifest and capability
protocol that other plugin categories will use. The manifest declares each
plugin's capability contract versions and network destinations; Braino rejects
incompatible or mismatched definitions before execution. When invoked,
third-party code runs only as a digest-pinned WebAssembly Component in a fresh
Wasmtime sandbox. It receives no ambient WASI capabilities: configuration,
secrets, allowlisted HTTPS, and
explicit operator-approved local services are mediated by the instance-local
plugin host. Ordinary plugin calls have no Braino-operated relay in their data
path. PostgreSQL stores the immutable component bytes by their
computed SHA-256 digest. The application is the only invocation broker: it
selects an enabled installation by workspace, validates the requested
capability, opens only that installation's secrets, and sends one complete
envelope to the private host.

Chat and embedding providers use the same boundary. Braino depends only on the
versioned `chat.complete` and `embedding.embed` contracts; model names,
credentials, endpoints, and provider-specific request formats belong to the
installed plugin. The application validates canonical inputs and outputs on
both sides of every invocation, and resolves exactly one enabled provider for
each capability. Adding another provider therefore requires a conforming plugin,
not a provider branch in Braino.

Each external source is bound to this Braino workspace, its credential is encrypted with
`DOCO_ENCRYPTION_KEY`, and its read-only records land in a private collection
with ordinary search, history, and audit behavior. For Slack, create a bot
token with `channels:read`, `channels:history`, and `users:read`; only public,
non-shared channels are copied. For Notion, create an internal integration with
read-content access and explicitly share the pages Braino should copy. For Google
Drive, enable the Drive API, create a service-account JSON key, and share the
folders or files with that service account; Braino imports Docs, Sheets, Slides,
and text files while ignoring binary files.

Slack also has an assistant plugin, separate from that read-only channel import.
Open **Admin → Integrations → Señor Braino for Slack** and install the official
Marketplace app. The independently deployed Braino plugin gateway owns Slack's
OAuth client, signing secret, and bot token; this instance receives only a
revocable credential scoped to its one installation. The gateway verifies Slack,
normalizes the event, and signs delivery to this deployment's public HTTPS
`DOCO_PUBLIC_HOST`. Braino durably queues that event before acknowledgement and
returns replies through the same gateway contract. The gateway cannot access
this instance's PostgreSQL, Qdrant, model credentials, retrieval state, or agent
tools, and no Braino instance can access another installation.

Owners connect one GitHub repository from **Admin → Integrations → Braino for
GitHub** by installing the official GitHub App. The independently deployed
Braino plugin gateway owns the App private key, webhook secret, installation
tokens, and provider delivery ledger. This instance stores only a revocable
credential scoped to its one installation, invokes the gateway through the
bundled `braino.github` WASI plugin, and receives signed normalized deliveries
at `/api/v1/plugins/github/events`. Set `DOCO_PUBLIC_HOST` to this deployment's
public HTTPS origin before installing.

Braino imports code, issues, and pull requests into dedicated collections and
records every source change in the same immutable history. GitHub deliveries
refresh automatically; both the gateway and this instance deduplicate retries.
Owners may enable **Require Braino on pull requests**, which reconciles a GitHub
ruleset requiring the `Braino` check. The check succeeds when the pull request
or one of its commits cites its Braino brief or record, and fails otherwise.
Existing personal-access-token connections migrate through the same screen:
Braino attaches the App, performs one successful gateway sync, and only then
deletes the old token and repository-webhook secret. New connections never ask
for or store a GitHub personal access token.

## Operations

The supported deployment includes preflight, backup, restore, and controlled
upgrade commands:

```sh
./doco doctor
./doco backup
./doco restore backups/doco-2026-11-08.tar.gz
./doco upgrade
```

PostgreSQL is the source of truth; Qdrant is cleared and rebuilt after a
restore, while the stateless CodeLinker and plugin host need no backup. Backups include
deployment configuration and are written with mode `0600`. See
[Operating Braino](docs/operations.md) for the full procedure.

The executable [v0.1 conformance contract](docs/v0.1-conformance.md) covers a
clean Docker boot in under ten minutes, the core product surfaces, and a
destructive backup/restore drill. A release cannot publish until it passes.

## Development

Requirements: Node.js 22+, pnpm 10.33.2, and Git.

```sh
pnpm install
pnpm verify
```

Development changes land through focused pull requests with the required checks
green and are squash-merged into `main`.

## License

Source code in this repository is available under the Mozilla Public License
2.0. See [LICENSE](LICENSE).
