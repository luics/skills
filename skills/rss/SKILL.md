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
node <skill>/scripts/rss.mjs sendmail [scope ...]
```

`fetch` is the default command. By default the scripts use `feeds.json` in the working directory; use `--feeds` when the file is elsewhere. Use `--dry-run` to fetch and render without advancing cursors. A scope is either an exact feed URL or a case-insensitive keyword matched against id, name, or URL. Process every matched feed once; report unmatched scopes without stopping other feeds. Do not request article pages: use only RSS/Atom content.

Treat a missing or blank `lastestArticleAt` as `1970-01-01T00:00:00Z`. Output only entries later than that cursor. After a successful feed fetch, advance its cursor to the latest newly fetched article, even when output is limited. Do not advance a failed feed. A feed with `disabled: true` must not be fetched; a missing or `false` value is enabled.

For conversational output, group feeds that have new entries with Markdown H2 headings. Render every title as `[MM.dd] article title` (with the title linked), omit a missing description, and summarize a description longer than 140 words or Chinese characters. Use `--html` for a self-contained email-friendly report or `--json` when another tool needs raw article metadata.

`sendmail` invokes `scripts/rss-mailer.mjs`, which calls the HTML fetch mode and delivers it through the local `sendmail` binary. Configure it with `MAIL_TO`, `MAIL_FROM`, `REPORT_TIMEZONE`, and `MAIL_SUBJECT_PREFIX`; `SENDMAIL_PATH` optionally overrides `/usr/sbin/sendmail`, and `DRY_RUN=1` tests without sending. Adding a feed initializes its cursor to the epoch; validate HTTP(S) URLs and unique ids/URLs. Deletion always requires `--confirm`.
