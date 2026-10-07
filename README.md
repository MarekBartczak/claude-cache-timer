# claude-cache-timer

A [Claude Code](https://claude.com/claude-code) mod that shows a live countdown until your session's **prompt cache** expires, and can keep the cache warm while you're away, so coming back to a long session doesn't re-cache the whole context from scratch.

```
⏳ cache 52:13 (TTL 1h) · ⟳ keep-alive 3h 41m · saved ~380k tok
```

## Why

Claude Code caches your conversation prefix on Anthropic's side. While the cache is warm, every new message reads the context from it cheaply. Once it expires (1 hour on a Claude subscription, 5 minutes on an API key), the next message writes the whole context to the cache again, and that write costs much more than a read.

| | Price vs. one uncached input token |
|---|---|
| Cache read | 0.05× (Opus 5.5), 0.1× (most models) |
| Cache write, 5-minute TTL | 1.25× |
| Cache write, 1-hour TTL | 2× |

With a 400k-token session that's the difference between ~20k and ~800k input-token equivalents for the first message after a break.

## Install

In a Claude Code terminal session:

```
/plugin install cache-timer --marketplace MarekBartczak/claude-cache-timer
```

Answer `y` to add the marketplace, pick a scope (user scope makes it load in every session), and confirm the options. The band appears above the prompt right away.

Requires a Claude Code build with function-hook plugins (mods). Developed and tested on **2.1.292**. The mod API is early access and may change between releases.

## What you see

A band above the prompt:

| Band | Meaning |
|---|---|
| `⏳ cache 52:13 (TTL 1h)` | Time left until the cache expires, counted from the last request of the main conversation |
| yellow `⏳ cache 4:59` | Less than 5 minutes left (1 minute on a 5m TTL), plus a one-time toast. Not shown while keep-alive covers it |
| `· ⟳ keep-alive 3h 41m` | Keep-alive is active and will keep refreshing the cache for this long |
| `· saved ~380k tok (Σ 2.1M)` | Net savings this session, and the running total across sessions |
| `❄ cache cold` / `❄ cache expired 3 min ago` | Nothing cached yet, or the cache is gone |

Subagent requests don't move the countdown, since they cache their own prefixes.

## Keep-alive

About 2 minutes before the cache would expire (1 minute on a 5m TTL), while no turn is running, the mod re-sends the conversation's last request with a one-word prompt through `$.model.fork`. That request **reads** the cache, which resets its timer. Nothing is added to your transcript or context.

- It runs for a window after your **last prompt** (default 4h), then stops and lets the cache expire. Each new prompt restarts the window.
- If a ping finds the cache already gone, it stops instead of paying to rebuild it.
- `/cache-ping` refreshes the cache on demand and tells you how many tokens it read from the cache. Use it once to confirm keep-alive works on your setup.

On Opus 5.5 an hourly ping costs about 1/40 of a re-cache, so keep-alive pays off if you come back within roughly 40 hours. The window guards against sessions you never return to: there, every ping is pure cost.

## Saved tokens

Counted in uncached-input-token equivalents, using API price ratios:

- Every ping is **subtracted** right away: input + cache read × read weight + output × 5.
- When you come back after the moment the cache would have expired without keep-alive, the first request's cache read is **credited** as the re-write it avoided: cached tokens × (write weight − read weight).

So the number can go negative when pings didn't pay off. On a subscription you're billed in usage limits, not tokens. Anthropic doesn't publish the exact weighting, so treat the figure as an estimate of direction and scale.

## Settings

In `/config`:

| Setting | Values | Default |
|---|---|---|
| Prompt cache TTL | `1h`, `5m` | `1h` |
| Cache keep-alive | `off`, `1h`, `2h`, `4h`, `8h` | `4h` |

The engine doesn't expose the TTL to mods, so the mod works it out in this order:

1. The TTL the engine reports on a model switch (`/model`).
2. What it observes: a cache hit after a 5–60 minute gap means 1h, a miss means 5m.
3. `CLAUDE_CODE_PROMPT_CACHE_TTL`, if set.
4. The setting above.

## Limitations

- Keep-alive works only while the Claude Code process is running. Closing the terminal stops it.
- Every open session pings on its own.
- The countdown and savings are estimates from what the API reports. A TTL drop mid-session (for example when usage switches to credits) is noticed after the first miss.

## Development

```sh
git clone https://github.com/MarekBartczak/claude-cache-timer
cd claude-cache-timer
claude plugin validate .
claude plugin test .
claude --plugin-dir .            # run a session with your working copy
```

To load your working copy in every session, add its path to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. In an interactive session, saving a file reloads the mod.

## License

[MIT](LICENSE)
