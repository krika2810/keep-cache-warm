# keep-cache-warm

`cache-keepalive`: a Claude Code mod (function-hooks plugin) that keeps the **1-hour prompt cache** from going cold while you step away.

## How it works

- Each time a main-thread turn finishes, the mod starts a countdown (default **55 minutes**).
- If no new turn starts before the countdown ends, the mod calls `$.model.fork` with a tiny "reply `ok`" prompt. The fork replays the main thread's last request (same model, system prompt, tools and messages), so the API serves that prefix from cache. A cache hit resets the cache's 60-minute TTL.
- Each successful ping restarts the countdown. A new turn from you resets everything.

### Safeguards

- **Ping cap:** it stops after `maxPings` pings in a row (default 6, about 5.5 hours) so an abandoned session doesn't keep spending. Set it to `0` for no limit.
- **Late timer:** if the timer fires 59 or more minutes after the cache was last warmed (for example, the laptop was asleep), it skips the ping. Rebuilding a cache that has already expired costs a full cache write.
- **No cache hit:** if a ping reads 0 tokens from cache, the mod stops until your next turn and shows a toast. This happens when the session uses the 5-minute TTL or the model was switched.
- Subagent turns don't reset the countdown, and no ping is sent while a turn is running.

### Cost

Each ping costs about one cache read of the conversation (0.1× the input price) plus a few output tokens. Without it, the first turn after the cache expires pays a full cache write (2× the input price for the 1-hour TTL).

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
| `idleMinutes` | 55 | Idle minutes before a ping (clamped to 1–59) |
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
