# Changelog

## 0.2.0 (2026-11-13)

First pi-pod release, published as `@pipod/pi-muse-subscription` from the upstream 0.1.0 fork.

- Add official-client device-code sign-in to `/login muse-sdk`, including pipod's remote auth UI. Pi stores a non-secret marker, not the client's tokens.
- Fix Muse 1.4.18 MCP admission by trusting an empty private workspace, without importing project hooks or rules a second time.
- Preserve complete tool batches when typed tool-start notifications precede the qualified experimental raw log.
- Await session-lease release on shutdown and remove stale exit listeners across Pi reloads.
- Own cancellation during startup and while tools are parked; bound catalog discovery and cancel it on shutdown.
- Reject malformed or non-object tool arguments instead of silently executing an empty argument object.
- Declare pod-only execution with `pipod.clientExtensions: []`; retain provider ID `muse-sdk`.
- Pin development to Pi 1.5.2 and use TypeBox's own exports in the existing checks.

## 0.1.0 (2026-10-30)

Initial release.

- Muse Spark and Muse Wonder models in pi through the Muse Code SDK and `muse serve`, on the Muse
  Code subscription login. Models come from Muse Code's live catalog for your plan.
- pi's system prompt and tools replace Muse Code's; Muse Code's observer agents, skill catalog and
  foreign rules are off, so a turn is one model request per step.
- pi's tools run through a loopback MCP bridge with parked calls; all calls of a response reach pi
  at once, and a message typed during a tool run is steered into the same turn.
- Divergence (abort, `/tree`, fork, restart) resumes or forks Muse Code's own session at the last
  completed turn; foreign history starts a fresh session carrying it as text.
- `META_API_KEY` is never passed on; Contributor mode follows your saved Muse Code setting, else off.
