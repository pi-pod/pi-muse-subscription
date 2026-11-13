import { spawnMspConnection } from "@muse-code/sdk";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { cleanEnv } from "./home.ts";

/** A local connection marker, never a Meta credential. The official client owns its login. */
export function clientLoginMarker(): OAuthCredentials {
	return { access: "muse-code-client-managed", refresh: "muse-code-client-managed", expires: Number.MAX_SAFE_INTEGER };
}

/** The device code travels through Pi's auth interaction, including pipod's remote auth bridge. */
export async function loginMuse(museBin: string, env: NodeJS.ProcessEnv, callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const deadline = AbortSignal.timeout(10 * 60_000);
	const signal = callbacks.signal ? AbortSignal.any([callbacks.signal, deadline]) : deadline;
	signal.throwIfAborted();
	const host = spawnMspConnection({ command: museBin, args: ["serve", "--no-session-log"], shutdownTimeoutMs: 1000, env: cleanEnv(env) });
	let finish!: (outcome: { outcome: string; message?: string }) => void;
	const completed = new Promise<{ outcome: string; message?: string }>((resolve) => { finish = resolve; });
	host.onNotification((notification) => {
		if (notification.method === "account/loginCompleted") finish(notification.params as { outcome: string; message?: string });
	});
	const aborted = new Promise<never>((_, reject) => {
		const abort = () => reject(signal.reason ?? new Error("Muse login cancelled"));
		signal.addEventListener("abort", abort, { once: true });
		void completed.finally(() => signal.removeEventListener("abort", abort));
	});
	// A host that dies must not leave the login waiting until the device code expires.
	const exited = host.exited.then(() => { throw new Error("Muse Code exited during sign-in"); });
	const wait = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, aborted, exited]);
	try {
		const initialized = await wait(host.initialize({ clientInfo: { name: "pipod_muse_login", version: "1" }, capabilities: { experimentalApi: true } }));
		const result = await wait(initialized.connection.request("account/loginStart", { type: "deviceCode" })) as { verificationUrl?: string; userCode?: string };
		if (!result.verificationUrl || !result.userCode) throw new Error("Muse Code did not return a device sign-in code");
		callbacks.onDeviceCode({ verificationUri: result.verificationUrl, userCode: result.userCode });
		callbacks.onProgress?.("Approve the device code in your browser. Credentials stay in the official Muse client on this machine.");
		const outcome = await wait(completed);
		if (outcome.outcome !== "granted") throw new Error(outcome.message || `Muse sign-in ${outcome.outcome}`);
		return clientLoginMarker();
	} finally {
		finish({ outcome: "cancelled" });
		await host.close().catch(() => undefined);
	}
}
