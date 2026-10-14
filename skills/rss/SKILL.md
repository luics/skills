---
name: rss
description: Fetch and manage local RSS/Atom subscriptions stored in feeds.json, including HTML email reports.
---

Run the bundled `scripts/rss.mjs` with the working directory set to the local RSS workspace that contains `feeds.json`. The scripts keep only feed definitions and cursors; do not create or use a post/article store.

```bash
node <skill>/scripts/rss.mjs [--feeds <absolute-path>] [fetch] [scope ...] [--limit <count>] [--dry-run] [--markdown|--html|--json]
node <skill>/scripts/rss.mjs feed list [--json]
node <skill>/scripts/rss.mjs feed add --id <id> --name <name> --url <RSS/Atom URL>
node <skill>/scripts/rss.mjs feed update <id|URL> [--id <id>] [--name <name>] [--url <RSS/Atom URL>] [--lastest-article-at <ISO-UTC>] [--disabled <true|false>]
node <skill>/scripts/rss.mjs feed remove <id|URL> --confirm
node <skill>/scripts/rss.mjs sendmail [scope ...] [--debug[=true|false]|--no-debug]
```

`fetch` is the default command. By default the scripts use `feeds.json` in the working directory; use `--feeds` when the file is elsewhere. Use `--dry-run` to fetch and render without advancing cursors. A scope is either an exact feed URL or a case-insensitive keyword matched against id, name, or URL. Process every matched feed once; report unmatched scopes without stopping other feeds. Do not request article pages: use only RSS/Atom content.

Treat a missing or blank `lastestArticleAt` as `1970-01-01T00:00:00Z`. Output only entries later than that cursor. After a successful feed fetch, advance its cursor to the latest newly fetched article, even when output is limited. Do not advance a failed feed. A feed with `disabled: true` must not be fetched; a missing or `false` value is enabled.

For conversational output, group feeds that have new entries with Markdown H2 headings. Render every title as `[MM.dd] article title` (with the title linked), omit a missing description, and summarize a description longer than 140 words or Chinese characters. Use `--html` for a self-contained email-friendly report or `--json` when another tool needs raw article metadata.

All runtime log lines use a UTC ISO 8601 prefix (`[YYYY-MM-DDTHH:mm:ss.sssZ]`), including warnings, errors, stack traces, and sendmail subprocess output. JSON, HTML, Markdown reports, feed tables, and help output retain their data formats without log prefixes.

The debug total-time row includes its breakdown in the same line: `总耗时（截至提交前）：xxs（拉取 xxs；翻译 xxs；渲染正文 xxs）`. Label an unexecuted stage “未执行” rather than reporting zero duration.

The mailer enables `--debug` by default. A separate final “调试信息” section includes article/failure/fallback counts, one “总耗时（截至提交前）” row, hotspot analysis, then a nested “订阅源” list. Omit the old total-time explanation row and the stage-duration row. Feed rows use `✅name：拉取 xxs；翻译 xxs；累计 xxs`, or ❌ when fetching/translation failed or timed out; unexecuted translation is labeled “未执行”. Do not include a “日志总结” row. Use `--debug=false`, `--debug false`, or `--no-debug` to omit this section while keeping normal status messages and runtime logs. The email's total is sampled before generating its final debug summary and submitting the message; submission duration and the final total are only available in runtime logs after sending. These flags work with both `rss.mjs sendmail` and direct `rss-mailer.mjs` invocation.

Every `sendmail` run logs timing events to stderr with a shared `run_id`: `total`, `fetch`, `fetch_feed`, `translate`, `translate_feed`, `render`, and `sendmail`. Stages emit `event=start` and `event=end`; end events include `status` and monotonic `duration_ms` to one decimal place. Feed events include `feed_id`. The total summary records `outcome` (`queued`, `dry_run`, or `failed`), translation fallback count, and, when fetching returned results, fetch failure count, discovered `new_articles`, and limited `report_articles`. Failed and timed-out work retains its elapsed time; stages not executed emit no timing events. Parent durations include child durations and must not be added together. `sendmail` measures MIME construction through local process closure, not inbox delivery. Capture both streams (for example, `2>&1 | tee -a rss-sendmail.log`) for a complete persistent log.

`sendmail` invokes `scripts/rss-mailer.mjs`, which fetches JSON, sends each successfully fetched feed to the local `codex exec` CLI for Simplified-Chinese translation, then renders and delivers HTML through the local `sendmail` binary. When the total new article count is zero, skip translation but still render and send an email showing “没有新文章。” with the available status/debug summary. This also applies when all feeds fail: report the failures in the email and log the run as partial after successful submission. `DRY_RUN=1` still prevents delivery. Redirect output to a log file when persistent logs are needed. Translation explicitly uses `gpt-6-luna` with `model_reasoning_effort="none"` to minimize cost and latency. A failed translation preserves that feed's original text and does not prevent delivery. Configure it with `MAIL_TO`, `MAIL_FROM`, `REPORT_TIMEZONE`, and `MAIL_SUBJECT_PREFIX`; `SENDMAIL_PATH` optionally overrides `/usr/sbin/sendmail`, `CODEX_EXECUTABLE` overrides `codex`, `CODEX_TRANSLATION_TIMEOUT_MS` controls the per-feed timeout (default: 120000), and `DRY_RUN=1` tests without sending. Adding a feed initializes its cursor to the epoch; validate HTTP(S) URLs and unique ids/URLs. Deletion always requires `--confirm`.
