// pi's own agent loop over this extension and a real `muse serve`, offline (fake model endpoint):
// node --experimental-strip-types test/pi-e2e.ts
// The fake model asks for pi's `read` tool on a real file, then answers with what it was given.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeMeta, type Json, reply, toolNames } from "./fake-meta.ts";

const root = mkdtempSync(join(tmpdir(), "pi-muse-e2e-"));
const xdg = join(root, "xdg");
mkdirSync(join(xdg, "muse"), { recursive: true });
writeFileSync(join(xdg, "muse", "auth.json"), JSON.stringify({ schema_version: 1, providers: { meta: { api_key: "unused" } } }));
const ws = join(root, "ws");
mkdirSync(ws);
writeFileSync(join(ws, "secret.txt"), "THE-SECRET-IS-42\n");

const fake = await new FakeMeta().start();
fake.modelIds.push("muse-catalog-e2e");
let sawResult = "";
fake.queue(
	(body) => reply({ text: "Reading it.", calls: [{ name: toolNames(body).includes("mcp__pi/read") ? "mcp__pi.read" : "missing", args: { path: "secret.txt" }, id: "call_e2e" }] }),
	(body: Json) => {
		const out = (body.input ?? []).find((i: Json) => i.type === "function_call_output");
		sawResult = typeof out?.output === "string" ? out.output : JSON.stringify(out?.output ?? "");
		return reply({ text: sawResult.includes("42") ? "The file says 42." : "no result" });
	},
);

const env = {
	...process.env,
	HOME: root,
	XDG_CONFIG_HOME: xdg,
	XDG_DATA_HOME: join(root, "data"),
	XDG_CACHE_HOME: join(root, "cache"),
	XDG_STATE_HOME: join(root, "state"),
	PI_CODING_AGENT_DIR: join(root, "agent"),
	TBH_CREDENTIAL_BACKEND: "file",
	TBH_DISABLE_TELEMETRY: "1",
	PI_MUSE_SDK_TEST_SETTINGS: JSON.stringify({ endpoint_transport: { base_url: fake.baseUrl, auth: "bearer" } }),
};
const extension = join(import.meta.dirname, "..", "src", "index.ts");
const listing = spawn("pi", ["--no-extensions", "-e", extension, "--no-session", "--list-models", "muse-sdk"], { cwd: ws, env });
let listed = "";
let listingError = "";
listing.stdout.on("data", (data) => { listed += data; });
listing.stderr.on("data", (data) => { listingError = (listingError + data).slice(-2000); });
assert.equal(await new Promise((resolve, reject) => { listing.on("error", reject); listing.on("close", resolve); }), 0, listingError);
assert.match(listed, /muse-catalog-e2e/, "startup lists live models absent from the bundled snapshot");
assert.equal(fake.bodies.length, 0, "model discovery never requests inference");

const child = spawn("pi", ["-e", extension, "--model", "muse-sdk/muse-spark-1.3", "--no-session", "-p", "What does secret.txt say?"], {
	cwd: ws,
	env,
	stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => (stdout += d));
child.stderr.on("data", (d) => (stderr += d));
const code = await new Promise((r) => child.on("exit", r));
await fake.close();
console.log(stdout.trim());
if (code !== 0) console.error(stderr.slice(-2000));
assert.equal(code, 0);
assert.equal(fake.bodies.length, 2, "one request per model step");
assert.ok(sawResult.includes("THE-SECRET-IS-42"), `pi's read tool result reached the model: ${sawResult}`);
assert.match(stdout, /The file says 42\./);
console.log("pi e2e: ok");
