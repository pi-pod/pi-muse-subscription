import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnMspConnection, type SpawnedMspConnection } from "@muse-code/sdk";
import type { Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import type { CallToolResult, McpBridge } from "./bridge.ts";
import { type InputPart, MCP_TOOLSET, toolArgsJson } from "./convert.ts";
import { assertMuseSubscription, cleanEnv, removeHostConfig, type SkillsOff, writeHostConfig } from "./home.ts";
import type { CatalogRow, MuseEffort } from "./models.ts";
import { AsyncQueue, errorText } from "./util.ts";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
/** MSP client names must match ^[a-z0-9_]+$. */
const CLIENT = { name: "pi_muse_subscription", version: VERSION };

export type OpenMode = { kind: "fresh" } | { kind: "resume"; sessionId: string } | { kind: "fork"; sessionId: string; turnId: string };

export interface HostSpec {
	cwd: string;
	model: string;
	systemPrompt: string;
	tools: Tool[];
	toolsHash: string;
	open: OpenMode;
	/** A tool-less one-shot request (compaction or branch summary): no tools, no persisted session. */
	ephemeral: boolean;
}

/** Where and how hosts run; shared by every host of the provider. */
export interface HostEnv {
	museBin: string;
	contributorMode: "on" | "off";
	bridge: McpBridge;
	/** pi's private directory for host configs. */
	baseDir: string;
	/** The user's Muse Code config directory (login state). */
	userConfigDir: string;
	skillsOff: (signal?: AbortSignal) => Promise<SkillsOff>;
	env: Record<string, string | undefined>;
	/** Extra Muse Code settings for every host (tests use a fake endpoint). */
	settingsOverlay?: Record<string, unknown>;
	debug?: (msg: string) => void;
}

export type ToolCallInfo = { callId: string; name: string; args: string };

/** Muse Code session activity, reduced to what a pi step needs. */
export type HostEvent =
	| { type: "turn_started"; turnId: string }
	| { type: "text_start"; itemId: string }
	| { type: "text_delta"; itemId: string; delta: string }
	| { type: "text_end"; itemId: string; text: string }
	| { type: "thinking_start"; itemId: string }
	| { type: "thinking_delta"; itemId: string; delta: string; part: number }
	| { type: "thinking_end"; itemId: string; text: string }
	| { type: "usage"; promptTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; finishReason?: string; modelId?: string }
	/** Every tool call of one model response, before Muse Code runs the first (raw log, experimental). */
	| { type: "tool_calls"; calls: ToolCallInfo[] }
	/** One tool call starting; Muse Code runs a response's calls one at a time. */
	| { type: "tool_started"; call: ToolCallInfo }
	| { type: "turn_completed"; turnId: string; terminal: string; error?: { kind?: string; message?: string }; reason?: string }
	| { type: "host_error"; message: string };

/** What the provider needs from a Muse Code session; MuseHost is the real one. */
export interface MuseSession {
	readonly spec: HostSpec;
	readonly sessionId: string;
	model: string;
	/** Chain hash and length of the pi transcript this session has consumed. */
	chain: string;
	count: number;
	/** Tool calls of the last step that pi has not answered yet. */
	awaiting: Set<string>;
	/** Tool calls already handed to pi as part of a step. */
	announced: Set<string>;
	turnId?: string;
	dead: boolean;
	busy: boolean;
	lastUsed: number;
	readonly events: AsyncQueue<HostEvent>;
	readonly exited: Promise<void>;
	readonly stderr: string;
	/** A qualified raw log supplies complete batches, possibly after typed tool-start events. */
	readonly rawLog?: boolean;
	startTurn(input: InputPart[], effort: MuseEffort): Promise<void>;
	steer(input: InputPart[]): Promise<void>;
	deliver(result: ToolResultMessage): void;
	setModel(model: string): Promise<void>;
	interrupt(): Promise<void>;
	close(): void;
}

/**
 * One `muse serve` process holding one Muse Code session. Muse Code runs with pi's system prompt
 * and only pi's tools, served over MCP by the bridge; a tool call parks until pi delivers its result
 * on the next provider call.
 */
export class MuseHost implements MuseSession {
	sessionId = "";
	model: string;
	chain = "";
	count = 0;
	awaiting = new Set<string>();
	announced = new Set<string>();
	turnId?: string;
	dead = false;
	busy = false;
	lastUsed = Date.now();
	readonly events = new AsyncQueue<HostEvent>();
	readonly exited: Promise<void>;
	private markExited!: () => void;

	private spawned?: SpawnedMspConnection;
	private pendingHost?: ReturnType<typeof spawnMspConnection>;
	private xdg?: string;
	private routeId?: string;
	private logSubscription?: number;
	private stderrTail = "";
	private readonly kinds = new Map<string, string>();
	private readonly parked = new Map<string, { resolve: (r: CallToolResult) => void; reject: (e: Error) => void }>();
	private readonly ready = new Map<string, CallToolResult>();
	private readonly decided = new Set<string>();

	readonly spec: HostSpec;
	private readonly host: HostEnv;

	private constructor(spec: HostSpec, host: HostEnv) {
		this.spec = spec;
		this.host = host;
		this.model = spec.model;
		this.exited = new Promise((r) => {
			this.markExited = r;
		});
	}

	static async open(spec: HostSpec, host: HostEnv, requestSignal?: AbortSignal): Promise<MuseHost> {
		const signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(requestSignal ? [requestSignal] : [])]);
		signal.throwIfAborted();
		const h = new MuseHost(spec, host);
		const abort = () => h.close();
		signal.addEventListener("abort", abort, { once: true });
		try {
			await h.init(signal);
			signal.throwIfAborted();
			return h;
		} catch (e) {
			h.close();
			await h.exited;
			throw new Error(errorText(signal.aborted ? signal.reason : e, h.stderr));
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}

	/** Whether every tool call of a response arrives up front (`tool_calls`), not one at a time. */
	get rawLog(): boolean {
		return this.logSubscription !== undefined;
	}

	private log(msg: string): void {
		this.host.debug?.(msg);
	}

	private async init(signal: AbortSignal): Promise<void> {
		const { spec, host } = this;
		assertMuseSubscription(host.userConfigDir);
		const skillsOff = await host.skillsOff(signal);
		signal.throwIfAborted();
		const id = randomUUID().replace(/-/g, "");
		let mcp: { url: string; token: string } | undefined;
		if (!spec.ephemeral) {
			mcp = await host.bridge.register(id, spec.tools, (callId) => this.onToolCall(callId));
			this.routeId = id;
			signal.throwIfAborted();
		}
		this.xdg = writeHostConfig(host.baseDir, id, host.userConfigDir, {
			systemPrompt: spec.systemPrompt,
			toolset: spec.ephemeral ? [] : [MCP_TOOLSET],
			...(mcp ? { mcpUrl: mcp.url } : {}),
			skillsOff,
			...(host.settingsOverlay ? { overlay: host.settingsOverlay } : {}),
		});
		// Muse 1.4.15+ starts MCP only in trusted workspaces. Trust an empty private
		// workspace, never the user's project: Pi alone owns project rules, hooks and tools.
		// Keep it across host restarts: Muse records this path in resumable sessions.
		const workspaceRoot = join(host.baseDir, "workspace");
		mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
		const args = ["serve", "--trust-workspace", "--contributor-mode", host.contributorMode, "--disable-request-user-input"];
		if (spec.ephemeral) args.push("--no-session-log");
		signal.throwIfAborted();
		const handshake = spawnMspConnection({
			command: host.museBin,
			shutdownTimeoutMs: 1000,
			args,
			cwd: workspaceRoot,
			env: cleanEnv({ ...host.env, XDG_CONFIG_HOME: this.xdg, PI_MUSE_MCP_AUTH: mcp ? `Bearer ${mcp.token}` : "" }),
			onStderr: (d) => {
				this.stderrTail = (this.stderrTail + d).slice(-4000);
			},
		});
		this.pendingHost = handshake;
		handshake.onNotification((n) => this.onNotification(n.method, (n.params ?? {}) as any));
		handshake.onServerRequest(async (r) => this.onServerRequest(r.method, (r.params ?? {}) as any));
		void handshake.exited.then(
			() => this.onExit(),
			() => this.onExit(),
		);
		this.spawned = await handshake.initialize({ clientInfo: CLIENT, capabilities: { experimentalApi: true, requestedCapabilities: ["rawLog"] } });
		signal.throwIfAborted();
		const c = this.spawned.connection;
		const open = spec.open;
		let result: any;
		if (open.kind === "fresh") result = await c.command("session/start", { workspaceRoot, modelId: spec.model, approvalMode: "allowAll" });
		else if (open.kind === "resume") result = await c.command("session/resume", { sessionId: open.sessionId, excludeItems: true, modelId: spec.model });
		else result = await c.command("session/fork", { sessionId: open.sessionId, cutPoint: { lastTurnId: open.turnId }, excludeItems: true });
		this.sessionId = String(result.session.sessionId);
		signal.throwIfAborted();
		if (open.kind !== "fresh") {
			await c.command("session/setApprovalMode", { sessionId: this.sessionId, mode: "allowAll" });
			if (open.kind === "fork") await c.command("session/setModel", { sessionId: this.sessionId, model: { modelId: spec.model } });
		}
		// rawLog is experimental. Only use its batch payload on the builds qualified here;
		// other clients retain the stable single-tool path rather than guessing at raw records.
		const version = this.spawned.initializeResult.serverInfo.version;
		if (/^1\.4\.(?:14|18|20)(?:$|[-+])/.test(version) && this.spawned.initializeResult.grantedCapabilities.includes("rawLog")) {
			try {
				const streams = (await c.command("log/streams", { sessionId: this.sessionId })) as any;
				const stream = (streams.streams ?? []).map((s: any) => s.stream).find((s: any) => s?.kind === "session") ?? { kind: "session", id: this.sessionId };
				const sub = (await c.command("log/subscribe", { sessionId: this.sessionId, stream })) as any;
				this.logSubscription = sub.subscriptionId;
			} catch (e) {
				this.log(`raw log unavailable (${errorText(e)}); tool calls arrive one at a time`);
			}
		}
	}

	private onNotification(method: string, p: any): void {
		if (method === "log/record") {
			if (p.subscriptionId !== this.logSubscription) return;
			const payload = p.record?.payload;
			const ev = payload?.event;
			if (payload?.kind === "run" && ev?.kind === "assistant_tool_calls_committed" && Array.isArray(ev.tool_calls)) {
				this.events.push({ type: "tool_calls", calls: ev.tool_calls.map((c: any) => ({ callId: String(c.call_id), name: String(c.name), args: toolArgsJson(c.args) })) });
			}
			return;
		}
		if (typeof p.sessionId === "string" && this.sessionId && p.sessionId !== this.sessionId) return;
		switch (method) {
			case "turn/started":
				this.turnId = p.turnId;
				this.events.push({ type: "turn_started", turnId: p.turnId });
				break;
			case "item/started": {
				const it = p.item ?? {};
				this.kinds.set(it.itemId, it.kind);
				if (it.kind === "agentMessage") this.events.push({ type: "text_start", itemId: it.itemId });
				else if (it.kind === "reasoning") this.events.push({ type: "thinking_start", itemId: it.itemId });
				else if (it.kind === "toolCall" && typeof it.callId === "string") this.events.push({ type: "tool_started", call: { callId: it.callId, name: String(it.tool ?? ""), args: toolArgsJson(it.args) } });
				break;
			}
			case "item/delta": {
				const kind = this.kinds.get(p.itemId);
				const field: string = p.field ?? "text";
				if (kind === "agentMessage" && field === "text") this.events.push({ type: "text_delta", itemId: p.itemId, delta: String(p.delta ?? "") });
				else if (kind === "reasoning" && field.startsWith("summary.")) this.events.push({ type: "thinking_delta", itemId: p.itemId, delta: String(p.delta ?? ""), part: Number(field.slice(8)) || 0 });
				break;
			}
			case "item/completed": {
				const it = p.item ?? {};
				const kind = this.kinds.get(it.itemId) ?? it.kind;
				this.kinds.delete(it.itemId);
				if (kind === "agentMessage") this.events.push({ type: "text_end", itemId: it.itemId, text: String(it.text ?? "") });
				else if (kind === "reasoning") this.events.push({ type: "thinking_end", itemId: it.itemId, text: Array.isArray(it.summary) && it.summary.length > 0 ? it.summary.join("\n\n") : String(it.text ?? "") });
				break;
			}
			case "session/tokenUsage": {
				const u = p.usage ?? {};
				this.events.push({
					type: "usage",
					promptTokens: Number(p.promptTokens ?? u.inputTokens ?? 0),
					outputTokens: Number(u.outputTokens ?? 0),
					cacheRead: Number(u.cacheReadTokens || u.cachedTokens || 0),
					cacheWrite: Number(u.cacheWriteTokens || 0),
					...(p.finishReason ? { finishReason: String(p.finishReason) } : {}),
					...(p.modelId ? { modelId: String(p.modelId) } : {}),
				});
				break;
			}
			case "turn/completed":
				this.events.push({ type: "turn_completed", turnId: p.turnId, terminal: String(p.terminal), ...(p.error ? { error: p.error } : {}), ...(p.reason ? { reason: String(p.reason) } : {}) });
				break;
			case "approval/requested":
				void this.approve(p);
				break;
		}
	}

	private async onServerRequest(method: string, p: any): Promise<Record<string, unknown>> {
		// The session runs with approval mode allowAll and only pi's tools; pi applies its own policy
		// when it runs them. Anything Muse Code still asks about is approved.
		if (method === "approval/request") void this.approve(p);
		return {};
	}

	private async approve(p: any): Promise<void> {
		if (!p?.approvalId || this.decided.has(p.approvalId)) return;
		const choice = (p.availableChoices ?? []).find((c: any) => c.decision === "approved") ?? (p.availableChoices ?? []).find((c: any) => String(c.decision).startsWith("approved"));
		if (!choice) return;
		this.decided.add(p.approvalId);
		try {
			await this.spawned?.connection.command("approval/decide", { sessionId: p.sessionId ?? this.sessionId, approvalId: p.approvalId, choiceId: choice.choiceId, requirementId: p.currentRequirementId });
		} catch (e) {
			this.log(`approval ${p.approvalId}: ${errorText(e)}`);
		}
	}

	private onToolCall(callId: string | undefined): Promise<CallToolResult> {
		if (!callId) return Promise.resolve({ content: [{ type: "text", text: "pi bridge: tool call without a call id" }], isError: true });
		this.lastUsed = Date.now();
		const done = this.ready.get(callId);
		if (done) {
			this.ready.delete(callId);
			return Promise.resolve(done);
		}
		if (this.dead) return Promise.reject(new Error("Muse host closed"));
		return new Promise((resolve, reject) => this.parked.set(callId, { resolve, reject }));
	}

	async startTurn(input: InputPart[], effort: MuseEffort): Promise<void> {
		assertMuseSubscription(this.host.userConfigDir);
		this.lastUsed = Date.now();
		const r = (await this.connection().command("turn/start", { sessionId: this.sessionId, input, reasoningEffort: effort })) as any;
		if (typeof r.turnId === "string") this.turnId = r.turnId;
	}

	/** Add input to the running turn; Muse Code shows it to the model at the next tool boundary. */
	async steer(input: InputPart[]): Promise<void> {
		assertMuseSubscription(this.host.userConfigDir);
		this.lastUsed = Date.now();
		await this.connection().command("turn/steer", { sessionId: this.sessionId, expectedTurnId: this.turnId, input });
	}

	/** Answer a parked (or soon to be issued) MCP tool call with pi's result. */
	deliver(result: ToolResultMessage): void {
		assertMuseSubscription(this.host.userConfigDir);
		const id = result.toolCallId;
		this.awaiting.delete(id);
		const r: CallToolResult = {
			content: result.content.map((c) => (c.type === "text" ? { type: "text", text: c.text } : { type: "image", data: c.data, mimeType: c.mimeType })),
			...(result.isError ? { isError: true } : {}),
		};
		if (r.content.length === 0) r.content.push({ type: "text", text: "(no output)" });
		const p = this.parked.get(id);
		if (p) {
			this.parked.delete(id);
			p.resolve(r);
		} else this.ready.set(id, r);
	}

	async setModel(model: string): Promise<void> {
		if (model === this.model) return;
		await this.connection().command("session/setModel", { sessionId: this.sessionId, model: { modelId: model } });
		this.model = model;
	}

	async interrupt(): Promise<void> {
		try {
			await this.connection().command("turn/interrupt", { sessionId: this.sessionId, ...(this.turnId ? { turnId: this.turnId } : {}) });
		} catch {}
	}

	private connection() {
		if (!this.spawned || this.dead) throw new Error("Muse host is not running");
		return this.spawned.connection;
	}

	close(): void {
		// Cleanup can be called again after cancellation during preparatory I/O.
		// Resources acquired just before the abort was observed still belong here.
		this.dead = true;
		if (this.routeId) this.host.bridge.unregister(this.routeId);
		for (const p of this.parked.values()) p.reject(new Error("Muse host closed"));
		this.parked.clear();
		if (this.spawned) void this.spawned.close().catch(() => {});
		else if (this.pendingHost) void this.pendingHost.close().catch(() => {});
		else this.onExit();
	}

	private onExit(): void {
		if (!this.dead) this.events.push({ type: "host_error", message: errorText(new Error("Muse Code exited unexpectedly"), this.stderrTail) });
		this.dead = true;
		if (this.routeId) this.host.bridge.unregister(this.routeId);
		for (const p of this.parked.values()) p.reject(new Error("Muse host exited"));
		this.parked.clear();
		this.events.close();
		removeHostConfig(this.xdg);
		this.markExited();
	}

	get stderr(): string {
		return this.stderrTail;
	}
}

/** Muse Code's live model catalog, or undefined when it cannot be read (no login, no network). */
export async function listModels(host: Omit<HostEnv, "bridge" | "skillsOff">, requestSignal?: AbortSignal): Promise<CatalogRow[] | undefined> {
	const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(requestSignal ? [requestSignal] : [])]);
	if (signal.aborted) return undefined;
	const id = `models-${randomUUID().replace(/-/g, "")}`;
	const xdg = writeHostConfig(host.baseDir, id, host.userConfigDir, { systemPrompt: "", toolset: [], skillsOff: {}, ...(host.settingsOverlay ? { overlay: host.settingsOverlay } : {}) });
	const handshake = spawnMspConnection({ command: host.museBin, args: ["serve", "--no-session-log"], shutdownTimeoutMs: 1000, env: cleanEnv({ ...host.env, XDG_CONFIG_HOME: xdg }) });
	const abort = () => { void handshake.close().catch(() => undefined); };
	signal.addEventListener("abort", abort, { once: true });
	try {
		signal.throwIfAborted();
		const spawned = await handshake.initialize({ clientInfo: CLIENT });
		signal.throwIfAborted();
		const r = (await spawned.connection.command("model/list", {})) as any;
		signal.throwIfAborted();
		if (r.source !== "providerCatalog" || !Array.isArray(r.models) || r.models.length === 0) return undefined;
		return r.models as CatalogRow[];
	} catch {
		return undefined;
	} finally {
		signal.removeEventListener("abort", abort);
		await handshake.close().catch(() => undefined);
		removeHostConfig(xdg);
	}
}
