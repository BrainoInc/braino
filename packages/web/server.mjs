import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withClient } from "@braino/db";
import { createRequestHandler } from "@react-router/express";
import express from "express";

export function trustSingleProxy(app) {
  app.set("trust proxy", 1);
  return app;
}

export function createApp(build) {
  const app = trustSingleProxy(express());
  app.disable("x-powered-by");

  app.use(
    `${build.publicPath}assets`,
    express.static(resolve(build.assetsBuildDirectory, "assets"), {
      immutable: true,
      maxAge: "1y",
    }),
  );
  app.use(build.publicPath, express.static(resolve(build.assetsBuildDirectory)));
  app.use(express.static("public", { maxAge: "1h" }));
  app.all("*", createRequestHandler({ build, mode: process.env.NODE_ENV }));

  return app;
}

async function run() {
  process.env.NODE_ENV ??= "production";
  const build = await import("./build/server/index.js");
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST;
  const server = createApp(build).listen(port, host, () => {
    console.log(`[braino] http://${host || "localhost"}:${port}`);
  });

  async function refreshCorpus() {
    try {
      await withClient((client) =>
        client.query(`SELECT refresh_collection_tokens()
        WHERE pg_try_advisory_xact_lock(hashtext('refresh_collection_tokens'))`),
      );
    } catch (error) {
      console.error("[braino] refreshing collection token counts failed", error);
    }
  }
  await refreshCorpus();
  const refreshTimer = setInterval(refreshCorpus, 60 * 60 * 1000);
  refreshTimer.unref();
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
      clearInterval(refreshTimer);
      server.close();
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run();
}
