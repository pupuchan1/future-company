import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { WorkerCaseClient } from "../../frontend/src/features/worker/cases.ts";
import { verifyBridgeProof } from "./bridge-proof.ts";
const origin = "http://localhost";
const staffToken = randomBytes(32).toString("hex");
let worker;
let unconfigured;
before(async () => {
  const bundle = await build({
    entryPoints: ["src/index.tsx"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    jsxImportSource: "hono/jsx",
    external: ["cloudflare:workers"],
    define: { "import.meta.env.PROD": "true" }
  });
  async function create(name, configured) {
    const mf = new Miniflare(convertV4MiniflareOptions({
      name,
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2025-08-03",
      durableObjects: { CASES: { className: "CaseRoom", useSQLite: true } },
      d1Databases: ["DB"],
      bindings: configured ? { STAFF_API_TOKEN: staffToken } : {},
      outboundService: () => new Response("External providers are disabled in this test.", { status: 502 })
    }));
    const db = await mf.getD1Database("DB");
    for (const file of (await readdir("migrations")).filter((name2) => name2.endsWith(".sql")).sort()) {
      for (const sql of (await readFile(`migrations/${file}`, "utf8")).split(";").filter((part) => part.trim())) await db.exec(sql.replaceAll("\n", " "));
    }
    return mf;
  }
  worker = await create("reception-proof-configured", true);
  unconfigured = await create("reception-proof-unconfigured", false);
}, { timeout: 2e4 });
after(async () => {
  await Promise.all([worker?.dispose(), unconfigured?.dispose()]);
});
function visitor(mf = worker) {
  let cookie = "";
  const calls = [];
  const fetcher = (async (path, init) => {
    const headers = new Headers(init?.headers);
    if (cookie) headers.set("Cookie", cookie);
    if (init?.method === "POST") headers.set("Origin", origin);
    const response = await mf.dispatchFetch(new URL(String(path), origin).href, { ...init, headers });
    const setCookie = response.headers.get("Set-Cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    calls.push({ path: String(path), init, status: response.status });
    return response;
  });
  return { client: new WorkerCaseClient(fetcher), fetcher, calls, cookie: () => cookie };
}
function tokenRequest(id, cookie = "", requestOrigin = origin) {
  return worker.dispatchFetch(`${origin}/api/v1/cases/${id}/bridge-token`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: requestOrigin }
  });
}
test("reception client obtains a real owner-scoped proof without duplicating the case or persisting credentials", async () => {
  const v = visitor();
  const [first, same] = await Promise.all([v.client.prepareVoice("ja"), v.client.prepareVoice("ja")]);
  assert.equal(first.case.id, same.case.id);
  assert.equal(first.bridgeToken, same.bridgeToken);
  assert.equal(first.case.kind, "haas");
  assert.deepEqual(v.calls.map((call) => call.status), [201, 200]);
  assert.match(v.calls[1].path, new RegExp(`/cases/${first.case.id}/bridge-token$`));
  assert.equal(v.calls[1].init?.credentials, "same-origin");
  assert.equal(v.calls[1].init?.redirect, "manual");
  assert.equal(await verifyBridgeProof(first.bridgeToken, first.case.id, staffToken), true);
  assert.equal(await verifyBridgeProof(first.bridgeToken, "another-case", staffToken), false);
  assert.equal(await verifyBridgeProof(first.bridgeToken, first.case.id, staffToken, Date.now() + 900001), false);
  const state = JSON.stringify(v.client.getSnapshot());
  assert.equal(state.includes(first.bridgeToken), false);
  assert.equal(state.includes(staffToken), false);
  const db = await worker.getD1Database("DB");
  const rows = await db.prepare("SELECT id,summary FROM cases WHERE id=?").bind(first.case.id).all();
  assert.equal(rows.results.length, 1);
  assert.equal(rows.results[0].summary.includes(first.bridgeToken), false);
  assert.equal(rows.results[0].summary.includes(staffToken), false);
  await v.client.prepareVoice("en");
  assert.deepEqual(v.calls.slice(2).map((call) => call.path), [`/api/v1/cases/${first.case.id}`, `/api/v1/cases/${first.case.id}/bridge-token`]);
});
test("the mounted proof endpoint rejects no cookie, another owner, forged identity and cross-origin requests", async () => {
  const owner = visitor(), other = visitor();
  const authorized = await owner.client.prepareVoice("en");
  await other.client.ensureCase("en");
  const path = authorized.case.id;
  for (const [cookie, requestOrigin, expected] of [
    ["", origin, 401],
    [other.cookie(), origin, 404],
    [owner.cookie(), "https://external.invalid", 403]
  ]) {
    const response = await tokenRequest(path, cookie, requestOrigin);
    assert.equal(response.status, expected);
    const body = await response.text();
    assert.equal(body.includes("bridgeToken"), false);
    assert.equal(body.includes(staffToken), false);
  }
  const forged = await worker.dispatchFetch(`${origin}/api/v1/cases/${path}/bridge-token`, {
    method: "POST",
    headers: { Origin: origin, Authorization: `Bearer ${staffToken}`, "x-internal-staff-id": "demo-staff" }
  });
  assert.equal(forged.status, 401, "A staff credential cannot substitute for the visitor owner cookie");
});
test("a Worker with no bridge secret can create an intake but cannot authorize voice", async () => {
  const v = visitor(unconfigured);
  await assert.rejects(v.client.prepareVoice("ja"), /503/);
  assert.deepEqual(v.calls.map((call) => call.status), [201, 503]);
  assert.equal(v.client.getSnapshot().case?.kind, "haas");
  assert.equal(v.client.getSnapshot().phase, "error");
  assert.equal(JSON.stringify(v.client.getSnapshot()).includes("bridgeToken"), false);
});
test("cancel after real Worker issuance ignores a delayed proof while retaining the owned case for retry", async () => {
  const v = visitor();
  let release;
  let issued;
  const waiting = new Promise((resolve) => {
    issued = resolve;
  });
  const delayed = new Promise((resolve) => {
    release = resolve;
  });
  let delay = true;
  const client = new WorkerCaseClient((async (path, init) => {
    const response = await v.fetcher(path, init);
    if (String(path).endsWith("/bridge-token") && delay) {
      issued();
      await delayed;
    }
    return response;
  }));
  const pending = client.prepareVoice("ja");
  await waiting;
  const id = client.getSnapshot().case.id;
  client.cancel();
  release();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(client.getSnapshot().phase, "ready");
  assert.equal(client.getSnapshot().case.id, id);
  assert.equal(JSON.stringify(client.getSnapshot()).includes("bridgeToken"), false);
  delay = false;
  const retry = await client.prepareVoice("ja");
  assert.equal(retry.case.id, id);
  assert.equal(await verifyBridgeProof(retry.bridgeToken, id, staffToken), true);
  assert.equal(v.calls.filter((call) => call.path === "/api/v1/cases").length, 1);
});
