# keep-cache-warm

`cache-keepalive`: a Claude Code mod (function-hooks plugin) that keeps the **1-hour prompt cache** from going cold while you step away.

## How it works

- A cache entry's 1-hour lifetime starts when the request that read or wrote it is **sent**, not when the response or the turn finishes. A 10-minute response leaves only 50 minutes. So the mod hooks `turn.step` and records when each main-thread model request is sent. It counts only requests whose response reports cache reads or writes.
- When a main-thread turn finishes, the mod starts a countdown. It ends **55 minutes** (the default) after the turn's last request was sent.
- If no new turn starts before then, the mod calls `$.model.fork` with a tiny "reply `ok`" prompt. The fork resends the main thread's last request exactly (same model, system prompt, tool definitions and messages) with that prompt appended. The API serves the whole prefix from the cache, and the read restarts the entry's 60-minute lifetime at no extra cost.
- The fork is not a turn of your conversation. Its tools are declared, so the prefix matches the cache, but every tool call it attempts is denied. Its own prompt and reply are never cached. The reply goes only to the mod, which discards it.
- Each successful ping restarts the countdown from when the ping was sent. A new turn from you resets everything.

### Safeguards

- **Ping cap:** it stops after `maxPings` pings in a row (default 6, about 5.5 hours) so an abandoned session doesn't keep spending. Set it to `0` for no limit.
- **Late timer:** if a ping would go out 59 or more minutes after the last request that touched the cache was sent, it is skipped. This covers a laptop that slept, or a turn whose last request was sent near the deadline. Rebuilding a cache that has already expired costs a full cache write.
- **No cache hit:** if a ping reads 0 tokens from the cache and writes some, the mod stops until your next turn and shows a toast. This happens when the session uses the 5-minute TTL or the model was switched.
- **Subagents:** their requests and turns are ignored. They send their own prefix and don't warm the main thread's.
- **No ping mid-turn:** no ping is sent while a turn is running.
- **Failed requests:** a request that got no response doesn't count as warming the cache.

### Cost

Each ping is billed as one cache read of the conversation, plus the fork's few uncached input tokens and its output (including any thinking). A cache read costs 0.1× the base input price on most models. It is lower on some: 0.05× on Claude Opus 5.5 and 0.025× on Claude Fable 5.1.

Without the ping, the first turn after the cache expires writes the whole conversation to the cache again. With the 1-hour TTL, that write costs 2× the base input price. Even the full run of 6 pings costs less than that one rewrite.

## Usage

```
/cache-keepalive           # status: minutes until the next ping, pings sent
/cache-keepalive off       # stop for this session
/cache-keepalive on        # resume
/cache-keepalive now       # ping immediately
```

The status line shows `cache keep-alive: armed (n/6)` while a countdown is running.

## Options (`/config` or `pluginConfigs` in settings)

| Field | Default | Meaning |
| --- | --- | --- |
| `idleMinutes` | 55 | Minutes after the last cache-touching request before a ping (clamped to 1–58, so a ping is always due before the 59-minute cutoff) |
| `maxPings` | 6 | Pings in a row before giving up; `0` means no limit |

## Load it

```sh
claude --plugin-dir ./keep-cache-warm
```

## Check it

```sh
claude plugin validate .
claude plugin test .
```
