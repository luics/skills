import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { encodeMimeHeader, parseTranslation, parseMailerOptions, summarizeTimings } from "../scripts/rss-mailer.mjs";
import { renderFetchHtml } from "../scripts/rss.mjs";

const execFileAsync = promisify(execFile);
const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rssCli = path.join(skillDir, "scripts", "rss.mjs");
const rssMailer = path.join(skillDir, "scripts", "rss-mailer.mjs");
const vergeFeedUrl = "https://www.theverge.com/rss/index.xml";

function timingEvents(stderr) {
  const lines = stderr.split("\n").filter((line) => / run_id=.* stage=/.test(line));
  const events = lines.map((line) => {
    assert.match(line, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
    return Object.fromEntries([...line.matchAll(/(\w+)=([^ ]+)/g)].map((match) => [match[1], match[2]]));
  });
  assert.ok(events.length > 0);
  assert.equal(new Set(events.map((event) => event.run_id)).size, 1);
  const starts = events.filter((event) => event.event === "start");
  const ends = events.filter((event) => event.event === "end");
  assert.equal(starts.length, ends.length);
  for (const end of ends) {
    assert.match(end.duration_ms, /^\d+\.\d$/);
    assert.equal(starts.filter((start) => start.stage === end.stage && start.feed_id === end.feed_id).length, 1);
  }
  return ends;
}

async function createWorkspace(t, feeds) {
  const workspace = await mkdtemp(path.join(tmpdir(), "rss-skill-test-"));
  const feedsPath = path.join(workspace, "feeds.json");
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(feedsPath, `${JSON.stringify(feeds, null, 2)}\n`);
  return { workspace, feedsPath };
}

function runRss(arguments_, workspace) {
  return execFileAsync(process.execPath, [rssCli, ...arguments_], {
    cwd: workspace,
    timeout: 40_000,
  });
}

async function startFixtureServer(t, routes) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const route = routes[request.url] || { status: 404, body: "not found" };
    response.writeHead(route.status ?? 200, {
      "content-type": route.contentType ?? "application/rss+xml; charset=utf-8",
      ...route.headers,
    });
    response.end(route.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return { requests, url: (pathname) => `http://127.0.0.1:${port}${pathname}` };
}

function rssItem({ title, url, description = "", publishedAt }) {
  return `<item><title>${title}</title><link>${url}</link><description>${description}</description><pubDate>${publishedAt}</pubDate></item>`;
}

function rssDocument(items) {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title>${items.join("")}</channel></rss>`;
}

async function writeFakeSendmail(workspace) {
  const executable = path.join(workspace, "fake-sendmail.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  if (process.env.CAPTURE_FILE) writeFileSync(process.env.CAPTURE_FILE, Buffer.concat(chunks));
  process.exit(Number(process.env.SENDMAIL_EXIT || 0));
});
`);
  await chmod(executable, 0o755);
  return executable;
}

async function writeFakeCodex(workspace) {
  const executable = path.join(workspace, "fake-codex.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf8");
  if (process.env.CODEX_HANG === "1") { setInterval(() => {}, 1000); return; }
  if (process.env.CODEX_CAPTURE_FILE) appendFileSync(process.env.CODEX_CAPTURE_FILE, JSON.stringify({ args: process.argv.slice(2), prompt }) + "\\n");
  if (Number(process.env.CODEX_EXIT || 0) !== 0) {
    console.error("fake Codex failure");
    process.exit(Number(process.env.CODEX_EXIT));
  }
  if (process.env.CODEX_OUTPUT !== undefined) process.stdout.write(process.env.CODEX_OUTPUT);
  else {
    const source = JSON.parse(prompt.slice(prompt.lastIndexOf("\\n") + 1));
    process.stdout.write(JSON.stringify({
      name: \`中文 \${source.name}\`,
      articles: source.articles.map((article) => ({ title: \`中文 \${article.title}\`, description: article.description ? \`中文 \${article.description}\` : "" })),
    }));
  }
});
`);
  await chmod(executable, 0o755);
  return executable;
}

test("renders a compact HTML report from The Verge RSS feed", { timeout: 45_000 }, async (t) => {
  const { workspace, feedsPath } = await createWorkspace(t, [{
    id: "the-verge",
    name: "The Verge",
    url: vergeFeedUrl,
    lastestArticleAt: "1970-01-01T00:00:00Z",
  }]);

  const { stdout, stderr } = await runRss([
    "fetch",
    "--feeds", feedsPath,
    "--dry-run",
    "--limit", "1",
    "--html",
  ], workspace);

  assert.equal(stderr, "");
  assert.match(stdout, /<!doctype html>/i);
  assert.match(stdout, /<section class="feed">/);
  assert.doesNotMatch(stdout, /RSS 最新文章/);
  assert.doesNotMatch(stdout, /按订阅源分组的本次抓取结果/);
  assert.match(stdout, /\.markdown-body\{max-width:900px;margin:auto;padding:8px 6px 0\}/);
  assert.match(stdout, /\.articles\{margin:8px 0 0;padding:0;list-style:none\}/);
  assert.match(stdout, /p\{margin:4px 0 0;padding-left:8px;/);
  assert.match(stdout, /<time>\[\d{2}\.\d{2}\]<\/time><a href="https:\/\//);
  assert.match(stdout, /min-width:49px;color:#1a7f37/);
  assert.match(stdout, /<meta name="color-scheme" content="light dark">/);
  assert.match(stdout, /@media\(prefers-color-scheme:dark\)/);

  const feedsAfterDryRun = JSON.parse(await readFile(feedsPath, "utf8"));
  assert.equal(feedsAfterDryRun[0].lastestArticleAt, "1970-01-01T00:00:00Z");
});

test("manages a feed through add, update, and confirmed removal", async (t) => {
  const { workspace, feedsPath } = await createWorkspace(t, []);

  const added = await runRss([
    "--feeds", feedsPath,
    "feed", "add",
    "--id", "the-verge",
    "--name", "The Verge",
    "--url", vergeFeedUrl,
  ], workspace);
  assert.match(added.stdout, /已添加 feed：The Verge（the-verge）。/);

  let feeds = JSON.parse(await readFile(feedsPath, "utf8"));
  assert.deepEqual(feeds, [{
    id: "the-verge",
    name: "The Verge",
    url: vergeFeedUrl,
    lastestArticleAt: "1970-01-01T00:00:00Z",
    disabled: false,
  }]);

  await runRss([
    "--feeds", feedsPath,
    "feed", "update", "the-verge",
    "--name", "The Verge Updates",
    "--disabled", "true",
  ], workspace);
  feeds = JSON.parse(await readFile(feedsPath, "utf8"));
  assert.equal(feeds[0].name, "The Verge Updates");
  assert.equal(feeds[0].disabled, true);

  await assert.rejects(
    runRss(["--feeds", feedsPath, "feed", "remove", "the-verge"], workspace),
    (error) => error.code === 1 && /删除 feed 需要明确确认/.test(error.stderr),
  );
  await runRss(["--feeds", feedsPath, "feed", "remove", "the-verge", "--confirm"], workspace);
  assert.deepEqual(JSON.parse(await readFile(feedsPath, "utf8")), []);
});

test("reports disabled feeds and unmatched scopes without fetching", async (t) => {
  const { workspace, feedsPath } = await createWorkspace(t, [{
    id: "the-verge",
    name: "The Verge",
    url: vergeFeedUrl,
    lastestArticleAt: "1970-01-01T00:00:00Z",
    disabled: true,
  }]);

  const { stdout } = await runRss([
    "fetch",
    "--feeds", feedsPath,
    "the-verge",
    "not-configured",
    "--markdown",
  ], workspace);

  assert.match(stdout, /没有新文章。/);
  assert.match(stdout, /未匹配的范围：not-configured。/);
  assert.match(stdout, /已禁用，未抓取：The Verge。/);
});

test("rejects invalid fetch options before requesting a feed", async (t) => {
  const { workspace, feedsPath } = await createWorkspace(t, []);

  await assert.rejects(
    runRss(["fetch", "--feeds", feedsPath, "--limit", "0"], workspace),
    (error) => error.code === 1 && /--limit 必须是正整数/.test(error.stderr),
  );
  await assert.rejects(
    runRss(["fetch", "--feeds", feedsPath, "--html", "--json"], workspace),
    (error) => error.code === 1 && /不能同时使用/.test(error.stderr),
  );
});

test("limits first-time feeds to 10 but returns all new articles for initialized feeds", async (t) => {
  const items = Array.from({ length: 15 }, (_, index) => rssItem({
    title: `Article ${index}`, url: `https://example.com/${index}`,
    publishedAt: new Date(Date.UTC(2024, 0, index + 1)).toUTCString(),
  }));
  const fixture = await startFixtureServer(t, { "/rss.xml": { body: rssDocument(items) } });
  const cursors = [undefined, "", "1970-01-01T00:00:00Z", "1970-01-01T00:00:00.000Z", "2023-12-31T00:00:00Z"];
  const { workspace } = await createWorkspace(t, cursors.map((cursor, index) => ({
    id: `feed-${index}`, name: `Feed ${index}`, url: fixture.url("/rss.xml"), lastestArticleAt: cursor,
  })));
  const { stdout } = await runRss(["fetch", "--json"], workspace);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.feeds.map((feed) => feed.articles.length), [10, 10, 10, 10, 15]);
  assert.ok(result.feeds.every((feed) => feed.newCount === 15));
  const saved = JSON.parse(await readFile(path.join(workspace, "feeds.json"), "utf8"));
  assert.ok(saved.every((feed) => feed.lastestArticleAt === "2024-01-15T00:00:00.000Z"));
});

test("advances the cursor to the newest article even when output is limited", async (t) => {
  const fixture = await startFixtureServer(t, {
    "/rss.xml": {
      body: rssDocument([
        rssItem({ title: "Older", url: "https://example.com/older", publishedAt: "Mon, 01 Jan 2024 00:00:00 GMT" }),
        rssItem({ title: "Newest", url: "https://example.com/newest", publishedAt: "Tue, 02 Jan 2024 00:00:00 GMT" }),
      ]),
    },
  });
  const feedUrl = fixture.url("/rss.xml");
  const { workspace, feedsPath } = await createWorkspace(t, [{
    id: "fixture",
    name: "Fixture",
    url: feedUrl,
    lastestArticleAt: "1970-01-01T00:00:00Z",
  }]);

  const { stdout } = await runRss(["fetch", "--feeds", feedsPath, "--limit", "1", "--json"], workspace);
  const result = JSON.parse(stdout);
  assert.equal(result.feeds[0].newCount, 2);
  assert.equal(result.feeds[0].articles.length, 1);
  assert.equal(result.feeds[0].articles[0].title, "Newest");
  assert.equal(JSON.parse(await readFile(feedsPath, "utf8"))[0].lastestArticleAt, "2024-01-02T00:00:00.000Z");
});

test("does not advance a feed cursor after a failed fetch", async (t) => {
  const fixture = await startFixtureServer(t, { "/unavailable.xml": { status: 503, body: "unavailable" } });
  const { workspace, feedsPath } = await createWorkspace(t, [{
    id: "unavailable",
    name: "Unavailable",
    url: fixture.url("/unavailable.xml"),
    lastestArticleAt: "2024-01-01T00:00:00Z",
  }]);

  await assert.rejects(
    runRss(["fetch", "--feeds", feedsPath, "--json"], workspace),
    (error) => error.code === 1,
  );
  assert.equal(JSON.parse(await readFile(feedsPath, "utf8"))[0].lastestArticleAt, "2024-01-01T00:00:00Z");
});

test("escapes article text and replaces unsafe article links in HTML", async (t) => {
  const fixture = await startFixtureServer(t, {
    "/unsafe.xml": {
      body: rssDocument([
        rssItem({
          title: "A &amp; B",
          url: "javascript:alert(1)",
          description: "Tom &amp; Jerry",
          publishedAt: "Mon, 01 Jan 2024 00:00:00 GMT",
        }),
      ]),
    },
  });
  const { workspace, feedsPath } = await createWorkspace(t, [{
    id: "unsafe",
    name: "Unsafe fixture",
    url: fixture.url("/unsafe.xml"),
    lastestArticleAt: "1970-01-01T00:00:00Z",
  }]);

  const { stdout } = await runRss(["fetch", "--feeds", feedsPath, "--dry-run", "--html"], workspace);
  assert.match(stdout, />A &amp; B<\/a>/);
  assert.match(stdout, /<p>Tom &amp; Jerry<\/p>/);
  assert.match(stdout, /<a href="#">A &amp; B<\/a>/);
  assert.doesNotMatch(stdout, /javascript:alert/);
});

test("parses Atom entries and their alternate links", async (t) => {
  const fixture = await startFixtureServer(t, {
    "/atom.xml": {
      contentType: "application/atom+xml; charset=utf-8",
      body: `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom entry</title><link rel="self" href="https://example.com/self"/><link rel="alternate" href="https://example.com/article"/><updated>2024-01-03T00:00:00Z</updated><summary>Atom summary</summary></entry></feed>`,
    },
  });
  const { workspace, feedsPath } = await createWorkspace(t, [{
    id: "atom",
    name: "Atom fixture",
    url: fixture.url("/atom.xml"),
    lastestArticleAt: "1970-01-01T00:00:00Z",
  }]);

  const { stdout } = await runRss(["fetch", "--feeds", feedsPath, "--dry-run", "--json"], workspace);
  const [article] = JSON.parse(stdout).feeds[0].articles;
  assert.equal(article.title, "Atom entry");
  assert.equal(article.url, "https://example.com/article");
  assert.equal(article.description, "Atom summary");
});

test("truncates long Chinese and English descriptions at 140 units", async (t) => {
  const englishWords = Array.from({ length: 141 }, () => "word").join(" ");
  const chineseCharacters = "你".repeat(141);
  const fixture = await startFixtureServer(t, {
    "/long-descriptions.xml": {
      body: rssDocument([
        rssItem({ title: "English", url: "https://example.com/english", description: englishWords, publishedAt: "Mon, 01 Jan 2024 00:00:00 GMT" }),
        rssItem({ title: "Chinese", url: "https://example.com/chinese", description: chineseCharacters, publishedAt: "Tue, 02 Jan 2024 00:00:00 GMT" }),
      ]),
    },
  });
  const { workspace, feedsPath } = await createWorkspace(t, [{
    id: "long-descriptions",
    name: "Long descriptions",
    url: fixture.url("/long-descriptions.xml"),
    lastestArticleAt: "1970-01-01T00:00:00Z",
  }]);

  const { stdout } = await runRss(["fetch", "--feeds", feedsPath, "--dry-run", "--markdown"], workspace);
  assert.match(stdout, new RegExp(`${Array.from({ length: 140 }, () => "word").join(" ")}…`));
  assert.match(stdout, new RegExp(`${"你".repeat(140)}…`));
  assert.doesNotMatch(stdout, new RegExp(`${"你".repeat(141)}…`));
});

test("matches scopes case-insensitively without fetching a feed twice", async (t) => {
  const fixture = await startFixtureServer(t, {
    "/rss.xml": {
      body: rssDocument([
        rssItem({ title: "Article", url: "https://example.com/article", publishedAt: "Mon, 01 Jan 2024 00:00:00 GMT" }),
      ]),
    },
  });
  const feedUrl = fixture.url("/rss.xml");
  const { workspace, feedsPath } = await createWorkspace(t, [{
    id: "the-verge",
    name: "The Verge",
    url: feedUrl,
    lastestArticleAt: "1970-01-01T00:00:00Z",
  }]);

  const { stdout } = await runRss([
    "fetch", "--feeds", feedsPath, "--dry-run", "--json",
    "THE-VERGE", "verge", feedUrl,
  ], workspace);
  assert.equal(JSON.parse(stdout).feeds.length, 1);
  assert.equal(fixture.requests.filter((pathname) => pathname === "/rss.xml").length, 1);
});

test("validates duplicate, unsupported, and malformed feed updates", async (t) => {
  const { workspace, feedsPath } = await createWorkspace(t, []);

  await assert.rejects(
    runRss(["--feeds", feedsPath, "feed", "add", "--id", "ftp", "--name", "FTP", "--url", "ftp://example.com/rss"], workspace),
    (error) => error.code === 1 && /必须使用 HTTP 或 HTTPS/.test(error.stderr),
  );
  await runRss(["--feeds", feedsPath, "feed", "add", "--id", "one", "--name", "One", "--url", "https://example.com/one"], workspace);
  await assert.rejects(
    runRss(["--feeds", feedsPath, "feed", "add", "--id", "one", "--name", "Duplicate id", "--url", "https://example.com/two"], workspace),
    (error) => error.code === 1 && /id 已存在/.test(error.stderr),
  );
  await assert.rejects(
    runRss(["--feeds", feedsPath, "feed", "add", "--id", "two", "--name", "Duplicate URL", "--url", "https://example.com/one"], workspace),
    (error) => error.code === 1 && /URL 已存在/.test(error.stderr),
  );
  await assert.rejects(
    runRss(["--feeds", feedsPath, "feed", "update", "one", "--lastest-article-at", "not-a-date"], workspace),
    (error) => error.code === 1 && /无效的 ISO 8601 时间/.test(error.stderr),
  );
});

test("encodes non-ASCII mail subjects and lets the mailer dry-run with RSS_FEEDS_PATH", async (t) => {
  assert.equal(encodeMimeHeader("RSS Reader"), "RSS Reader");
  assert.equal(encodeMimeHeader("RSS 阅读器"), "=?UTF-8?B?UlNTIOmYheivu+WZqA==?=");

  const fixture = await startFixtureServer(t, {
    "/rss.xml": {
      body: rssDocument([
        rssItem({ title: "Article", url: "https://example.com/article", publishedAt: "Mon, 01 Jan 2024 00:00:00 GMT" }),
      ]),
    },
  });
  const { workspace, feedsPath } = await createWorkspace(t, [{
    id: "mailer",
    name: "Mailer fixture",
    url: fixture.url("/rss.xml"),
    lastestArticleAt: "1970-01-01T00:00:00Z",
  }]);
  const fakeCodex = await writeFakeCodex(workspace);

  const outputHtml = path.join(workspace, "preview.html");
  const { stdout, stderr } = await execFileAsync(process.execPath, [rssMailer, "--output-html", outputHtml], {
    cwd: workspace,
    env: { ...process.env, DRY_RUN: "1", RSS_FEEDS_PATH: feedsPath, MAIL_TO: "test@example.com", CODEX_EXECUTABLE: fakeCodex },
  });
  assert.match(stdout, /Dry run: generated RSS email for test@example.com without sending/);
  const events = timingEvents(stderr);
  assert.equal(events.at(-1).outcome, "dry_run");
  assert.ok(events.every((event) => event.stage !== "sendmail"));
  assert.match(await readFile(outputHtml, "utf8"), /<h2>调试信息<\/h2>/);
});

test("sends a status report when all feeds fail without translating", async (t) => {
  const fixture = await startFixtureServer(t, { "/bad.xml": { status: 500, body: "unavailable" } });
  const { workspace } = await createWorkspace(t, [{ id: "bad", name: "Bad feed", url: fixture.url("/bad.xml") }]);
  const fakeSendmail = await writeFakeSendmail(workspace);
  const capturedMail = path.join(workspace, "message.eml");
  const { stderr } = await execFileAsync(process.execPath, [rssCli, "sendmail"], {
    cwd: workspace,
    env: { ...process.env, DRY_RUN: "0", SENDMAIL_PATH: fakeSendmail, CAPTURE_FILE: capturedMail },
  });
  const events = timingEvents(stderr);
  assert.deepEqual(events.map((event) => event.stage), ["fetch_feed", "fetch", "render", "sendmail", "total"]);
  assert.equal(events[0].status, "error");
  assert.equal(events.at(-1).status, "partial");
  assert.equal(events.at(-1).outcome, "queued");
  assert.equal(events.at(-1).fetch_failures, "1");
  const message = await readFile(capturedMail, "utf8");
  const html = Buffer.from(message.split("\r\n\r\n")[1], "base64").toString("utf8");
  assert.match(html, /没有新文章/);
  assert.match(html, /抓取失败：Bad feed/);
});

test("keeps failed-feed cursors while advancing successful feeds in a mixed run", async (t) => {
  const fixture = await startFixtureServer(t, {
    "/success.xml": {
      body: rssDocument([
        rssItem({ title: "Success", url: "https://example.com/success", publishedAt: "Wed, 03 Jan 2024 00:00:00 GMT" }),
      ]),
    },
    "/failure.xml": { status: 503, body: "unavailable" },
  });
  const { workspace, feedsPath } = await createWorkspace(t, [
    { id: "success", name: "Success", url: fixture.url("/success.xml"), lastestArticleAt: "1970-01-01T00:00:00Z" },
    { id: "failure", name: "Failure", url: fixture.url("/failure.xml"), lastestArticleAt: "2024-01-01T00:00:00Z" },
  ]);

  let error;
  try {
    await runRss(["fetch", "--feeds", feedsPath, "--json"], workspace);
  } catch (caught) {
    error = caught;
  }
  assert.equal(error?.code, 1);
  const result = JSON.parse(error.stdout);
  assert.equal(result.feeds[0].articles[0].title, "Success");
  assert.equal(result.failures[0].name, "Failure");
  const feeds = JSON.parse(await readFile(feedsPath, "utf8"));
  assert.equal(feeds[0].lastestArticleAt, "2024-01-03T00:00:00.000Z");
  assert.equal(feeds[1].lastestArticleAt, "2024-01-01T00:00:00Z");
});

test("skips malformed and incomplete entries without moving the cursor", async (t) => {
  const fixture = await startFixtureServer(t, {
    "/malformed.xml": {
      body: "<?xml version=\"1.0\"?><rss><channel><item><title>Truncated",
    },
    "/incomplete.xml": {
      body: `<?xml version="1.0"?><rss><channel>${[
        "<item><title>Missing link</title><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>",
        "<item><title>Invalid date</title><link>https://example.com/invalid-date</link><pubDate>never</pubDate></item>",
        "<item><link>https://example.com/missing-title</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>",
      ].join("")}</channel></rss>`,
    },
  });
  const { workspace, feedsPath } = await createWorkspace(t, [
    { id: "malformed", name: "Malformed", url: fixture.url("/malformed.xml"), lastestArticleAt: "2024-01-01T00:00:00Z" },
    { id: "incomplete", name: "Incomplete", url: fixture.url("/incomplete.xml"), lastestArticleAt: "2024-01-01T00:00:00Z" },
  ]);

  const { stdout } = await runRss(["fetch", "--feeds", feedsPath, "--json"], workspace);
  assert.deepEqual(JSON.parse(stdout).feeds.map((feed) => feed.articles), [[], []]);
  assert.deepEqual(JSON.parse(await readFile(feedsPath, "utf8")).map((feed) => feed.lastestArticleAt), ["2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"]);
});

test("follows relative redirects and decodes compressed RSS responses", async (t) => {
  const article = rssItem({ title: "Compressed", url: "https://example.com/compressed", publishedAt: "Mon, 01 Jan 2024 00:00:00 GMT" });
  const source = rssDocument([article]);
  const fixture = await startFixtureServer(t, {
    "/redirect.xml": { status: 302, headers: { location: "/gzip.xml" }, body: "" },
    "/gzip.xml": { headers: { "content-encoding": "gzip" }, body: gzipSync(source) },
    "/deflate.xml": { headers: { "content-encoding": "deflate" }, body: deflateSync(source) },
    "/brotli.xml": { headers: { "content-encoding": "br" }, body: brotliCompressSync(source) },
  });
  const { workspace, feedsPath } = await createWorkspace(t, [
    { id: "redirect", name: "Redirect", url: fixture.url("/redirect.xml"), lastestArticleAt: "1970-01-01T00:00:00Z" },
    { id: "deflate", name: "Deflate", url: fixture.url("/deflate.xml"), lastestArticleAt: "1970-01-01T00:00:00Z" },
    { id: "brotli", name: "Brotli", url: fixture.url("/brotli.xml"), lastestArticleAt: "1970-01-01T00:00:00Z" },
  ]);

  const { stdout } = await runRss(["fetch", "--feeds", feedsPath, "--dry-run", "--json"], workspace);
  assert.deepEqual(JSON.parse(stdout).feeds.map((feed) => feed.articles[0].title), ["Compressed", "Compressed", "Compressed"]);
  assert.ok(fixture.requests.includes("/redirect.xml"));
  assert.ok(fixture.requests.includes("/gzip.xml"));
});

test("does not advance a cursor after too many redirects", async (t) => {
  const routes = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
    `/redirect-${index}.xml`,
    { status: 302, headers: { location: `/redirect-${index + 1}.xml` }, body: "" },
  ]));
  const fixture = await startFixtureServer(t, routes);
  const { workspace, feedsPath } = await createWorkspace(t, [{
    id: "redirect-loop",
    name: "Redirect loop",
    url: fixture.url("/redirect-0.xml"),
    lastestArticleAt: "2024-01-01T00:00:00Z",
  }]);

  await assert.rejects(
    runRss(["fetch", "--feeds", feedsPath, "--json"], workspace),
    (error) => error.code === 1,
  );
  assert.equal(JSON.parse(await readFile(feedsPath, "utf8"))[0].lastestArticleAt, "2024-01-01T00:00:00Z");
  assert.ok(fixture.requests.includes("/redirect-5.xml"));
});

test("reports escaped disabled and unmatched values in HTML status", async (t) => {
  const { workspace, feedsPath } = await createWorkspace(t, [{
    id: "disabled",
    name: "Bad <script>alert(1)</script>",
    url: "https://example.com/disabled.xml",
    lastestArticleAt: "1970-01-01T00:00:00Z",
    disabled: true,
  }]);

  const { stdout } = await runRss(["fetch", "--feeds", feedsPath, "disabled", "<img src=x onerror=alert(1)>", "--html"], workspace);
  assert.match(stdout, /Bad &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(stdout, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(stdout, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(stdout, /<img src=x onerror=alert\(1\)>/);
});

test("rejects missing, malformed, and invalid feed configuration", async (t) => {
  const { workspace, feedsPath } = await createWorkspace(t, []);
  await rm(feedsPath);
  await assert.rejects(
    runRss(["fetch", "--feeds", feedsPath], workspace),
    (error) => error.code === 1 && /无法读取/.test(error.stderr),
  );
  await writeFile(feedsPath, "not JSON");
  await assert.rejects(
    runRss(["fetch", "--feeds", feedsPath], workspace),
    (error) => error.code === 1 && /无法读取/.test(error.stderr),
  );
  await writeFile(feedsPath, JSON.stringify([{ id: "invalid", name: "Invalid", url: "https://example.com/rss", disabled: "yes" }]));
  await assert.rejects(
    runRss(["fetch", "--feeds", feedsPath], workspace),
    (error) => error.code === 1 && /disabled 必须是布尔值/.test(error.stderr),
  );
});

test("sends MIME email through a fake sendmail command and surfaces delivery failures", async (t) => {
  const fixture = await startFixtureServer(t, {
    "/rss.xml": {
      body: rssDocument([
        rssItem({ title: "Article", url: "https://example.com/article", publishedAt: "Mon, 01 Jan 2024 00:00:00 GMT" }),
      ]),
    },
  });
  const { workspace, feedsPath } = await createWorkspace(t, [{
    id: "mailer",
    name: "Mailer fixture",
    url: fixture.url("/rss.xml"),
    lastestArticleAt: "1970-01-01T00:00:00Z",
  }]);
  const fakeSendmail = await writeFakeSendmail(workspace);
  const fakeCodex = await writeFakeCodex(workspace);
  const capturedMessage = path.join(workspace, "message.eml");
  const environment = {
    ...process.env,
    RSS_FEEDS_PATH: feedsPath,
    MAIL_TO: "test@example.com",
    MAIL_SUBJECT_PREFIX: "RSS 阅读器",
    SENDMAIL_PATH: fakeSendmail,
    CODEX_EXECUTABLE: fakeCodex,
    CAPTURE_FILE: capturedMessage,
  };

  const sent = await execFileAsync(process.execPath, [rssCli, "sendmail", "--output-html=report.html"], { cwd: workspace, env: environment });
  assert.match(sent.stdout, /Queued RSS email for test@example.com/);
  const sentEvents = timingEvents(sent.stderr);
  assert.deepEqual(sentEvents.map((event) => event.stage), ["fetch_feed", "fetch", "translate_feed", "translate", "render", "sendmail", "total"]);
  assert.ok(sentEvents.every((event) => event.status === "ok"));
  assert.equal(sentEvents.at(-1).outcome, "queued");
  assert.equal(sentEvents.at(-1).new_articles, "1");
  assert.equal(sentEvents.at(-1).report_articles, "1");
  const message = await readFile(capturedMessage, "utf8");
  assert.match(message, /Subject: =\?UTF-8\?B\?/);
  assert.match(message, /Content-Transfer-Encoding: base64/);
  const encodedHtml = message.split("\r\n\r\n")[1].replaceAll("\r\n", "").trim();
  const html = Buffer.from(encodedHtml, "base64").toString("utf8");
  assert.equal(await readFile(path.join(workspace, "report.html"), "utf8"), html);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /中文 Article/);
  assert.match(html, /<h2>调试信息<\/h2>/);
  assert.match(html, /总耗时（截至提交前）/);
  assert.match(html, /<table><caption>订阅源/);
  assert.match(html, /<td>✅Mailer fixture<\/td>/);
  assert.match(html, /耗时热点/);

  await rm(capturedMessage);
  const capturedPrompts = path.join(workspace, "empty-prompts.jsonl");
  const empty = await execFileAsync(process.execPath, [rssCli, "sendmail"], {
    cwd: workspace,
    env: { ...environment, DRY_RUN: "0", CODEX_CAPTURE_FILE: capturedPrompts },
  });
  assert.match(empty.stdout, /Queued RSS email/);
  const emptyEvents = timingEvents(empty.stderr);
  assert.deepEqual(emptyEvents.map((event) => event.stage), ["fetch_feed", "fetch", "render", "sendmail", "total"]);
  assert.equal(emptyEvents.at(-1).outcome, "queued");
  assert.equal(emptyEvents.at(-1).new_articles, "0");
  const emptyMail = await readFile(capturedMessage, "utf8");
  const emptyHtml = Buffer.from(emptyMail.split("\r\n\r\n")[1], "base64").toString("utf8");
  assert.match(emptyHtml, /没有新文章/);
  assert.match(emptyHtml, /总耗时（截至提交前）/);
  await assert.rejects(readFile(capturedPrompts), { code: "ENOENT" });

  await runRss(["feed", "update", "mailer", "--lastest-article-at", "1970-01-01T00:00:00Z"], workspace);
  const noDebug = await execFileAsync(process.execPath, [rssCli, "sendmail", "--debug=false"], { cwd: workspace, env: environment });
  assert.equal(timingEvents(noDebug.stderr).at(-1).outcome, "queued");
  const plainMail = await readFile(capturedMessage, "utf8");
  const plainHtml = Buffer.from(plainMail.split("\r\n\r\n")[1].replaceAll("\r\n", "").trim(), "base64").toString("utf8");
  assert.doesNotMatch(plainHtml, /日志总结|耗时热点|总耗时（截至提交前）/);

  await runRss(["feed", "update", "mailer", "--lastest-article-at", "1970-01-01T00:00:00Z"], workspace);
  await assert.rejects(
    execFileAsync(process.execPath, [rssMailer], { cwd: workspace, env: { ...environment, SENDMAIL_EXIT: "2" } }),
    (error) => {
      const events = timingEvents(error.stderr);
      assert.equal(events.find((event) => event.stage === "sendmail").status, "error");
      assert.equal(events.at(-1).outcome, "failed");
      return error.code === 1 && /sendmail exited with code 2/.test(error.stderr);
    },
  );
});

test("translates every fetched feed from JSON before mail HTML rendering", async (t) => {
  const fixture = await startFixtureServer(t, {
    "/one.xml": { body: rssDocument([rssItem({ title: "One", url: "https://example.com/one", description: "First", publishedAt: "Mon, 01 Jan 2024 00:00:00 GMT" })]) },
    "/two.xml": { body: rssDocument([rssItem({ title: "Two", url: "https://example.com/two", description: "Second", publishedAt: "Tue, 02 Jan 2024 00:00:00 GMT" })]) },
  });
  const { workspace, feedsPath } = await createWorkspace(t, [
    { id: "one", name: "One feed", url: fixture.url("/one.xml"), lastestArticleAt: "1970-01-01T00:00:00Z" },
    { id: "two", name: "Two feed", url: fixture.url("/two.xml"), lastestArticleAt: "1970-01-01T00:00:00Z" },
  ]);
  const fakeSendmail = await writeFakeSendmail(workspace);
  const fakeCodex = await writeFakeCodex(workspace);
  const capturedMail = path.join(workspace, "message.eml");
  const capturedPrompts = path.join(workspace, "codex-prompts.jsonl");
  await execFileAsync(process.execPath, [rssMailer], {
    cwd: workspace,
    env: {
      ...process.env, RSS_FEEDS_PATH: feedsPath, SENDMAIL_PATH: fakeSendmail, CODEX_EXECUTABLE: fakeCodex,
      MAIL_TO: "test@example.com", CAPTURE_FILE: capturedMail, CODEX_CAPTURE_FILE: capturedPrompts,
    },
  });
  const prompts = (await readFile(capturedPrompts, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts.map(({ args }) => args), [
    ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--model", "gpt-6-luna", "--config", 'model_reasoning_effort="none"', "-"],
    ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--model", "gpt-6-luna", "--config", 'model_reasoning_effort="none"', "-"],
  ]);
  assert.match(prompts[0].prompt, /"id":"one"/);
  assert.match(prompts[1].prompt, /"id":"two"/);
  const message = await readFile(capturedMail, "utf8");
  const html = Buffer.from(message.split("\r\n\r\n")[1].replaceAll("\r\n", "").trim(), "base64").toString("utf8");
  assert.match(html, /中文 One feed/);
  assert.match(html, /中文 Two/);
});

test("keeps original feed text when Codex fails or returns invalid translations", async (t) => {
  const fixture = await startFixtureServer(t, {
    "/rss.xml": { body: rssDocument([rssItem({ title: "Original title", url: "https://example.com/original", description: "Original description", publishedAt: "Mon, 01 Jan 2024 00:00:00 GMT" })]) },
  });
  for (const [name, codexEnvironment] of [
    ["non-zero exit", { CODEX_EXIT: "2" }],
    ["invalid JSON", { CODEX_OUTPUT: "not JSON" }],
    ["invalid schema", { CODEX_OUTPUT: '{"name":"Translated","articles":[]}' }],
    ["timeout", { CODEX_HANG: "1", CODEX_TRANSLATION_TIMEOUT_MS: "200" }],
  ]) {
    await t.test(name, async (t) => {
      const { workspace, feedsPath } = await createWorkspace(t, [{ id: "fallback", name: "Original feed", url: fixture.url("/rss.xml"), lastestArticleAt: "1970-01-01T00:00:00Z" }]);
      const fakeSendmail = await writeFakeSendmail(workspace);
      const fakeCodex = await writeFakeCodex(workspace);
      const capturedMail = path.join(workspace, "message.eml");
      const { stderr } = await execFileAsync(process.execPath, [rssMailer], {
        cwd: workspace,
        env: { ...process.env, ...codexEnvironment, RSS_FEEDS_PATH: feedsPath, SENDMAIL_PATH: fakeSendmail, CODEX_EXECUTABLE: fakeCodex, MAIL_TO: "test@example.com", CAPTURE_FILE: capturedMail },
      });
      assert.match(stderr, /翻译失败，保留原文：Original feed/);
      const events = timingEvents(stderr);
      assert.equal(events.find((event) => event.stage === "translate_feed").status, name === "timeout" ? "timeout" : "error");
      assert.equal(events.find((event) => event.stage === "translate").status, "partial");
      assert.equal(events.at(-1).translation_fallbacks, "1");
      assert.equal(events.at(-1).outcome, "queued");
      const message = await readFile(capturedMail, "utf8");
      const html = Buffer.from(message.split("\r\n\r\n")[1].replaceAll("\r\n", "").trim(), "base64").toString("utf8");
      assert.match(html, /Original title/);
      assert.match(html, /Original description/);
      assert.match(html, /翻译回退原文 1 个源/);
    });
  }
});

test("debug options default on and do not leak into feed scopes", () => {
  assert.deepEqual(parseMailerOptions(["verge"]), { scopes: ["verge"], debug: true });
  for (const flags of [["--debug=false"], ["--debug", "false"], ["--no-debug"]]) {
    assert.deepEqual(parseMailerOptions([...flags, "verge"]), { scopes: ["verge"], debug: false });
  }
  assert.deepEqual(parseMailerOptions(["--debug", "verge"]), { scopes: ["verge"], debug: true });
  assert.throws(() => parseMailerOptions(["--debug=invalid"]), /true 或 false/);
  assert.deepEqual(parseMailerOptions(["--output-html", "report.html", "verge"]), { scopes: ["verge"], debug: true, outputHtml: "report.html" });
  assert.deepEqual(parseMailerOptions(["--output-html=report.html"]), { scopes: [], debug: true, outputHtml: "report.html" });
  for (const flags of [["--output-html"], ["--output-html="], ["--output-html", "--no-debug"]]) {
    assert.throws(() => parseMailerOptions(flags), /需要指定文件路径/);
  }
});

test("debug summary derives hotspots from timings and escapes source names", () => {
  const result = {
    feeds: [
      { id: "one", name: "<script>source</script>", articles: [], newCount: 2 },
      { id: "two", name: "Second feed", articles: [], newCount: 3 },
    ],
    failures: [{ id: "bad", name: "Bad source", error: "unavailable" }],
    disabled: [], unmatched: [],
  };
  const events = [
    { stage: "fetch", duration_ms: 200 },
    { stage: "translate", duration_ms: 700 },
    { stage: "render", duration_ms: 10 },
    { stage: "fetch_feed", feed_id: "one", duration_ms: 100, status: "ok" },
    { stage: "fetch_feed", feed_id: "bad", duration_ms: 50, status: "error" },
    { stage: "fetch_feed", feed_id: "two", duration_ms: 300, status: "ok" },
    { stage: "translate_feed", feed_id: "two", duration_ms: 10, status: "ok" },
    { stage: "translate_feed", feed_id: "one", duration_ms: 690, status: "timeout" },
  ];
  const summary = summarizeTimings(result, events, { new_articles: 2, report_articles: 1, fetch_failures: 1, translation_fallbacks: 1 }, 1000, "test-run");
  const html = renderFetchHtml(result, summary);
  assert.match(html, /总耗时（截至提交前）：1.0s（拉取 0.2s；翻译 0.7s；渲染正文 0.010s）/);
  assert.match(html, /<li>耗时热点：<ul><li>翻译最耗时：0.7s（～70.0%）<\/li><li>最慢订阅源为 Second feed：0.7s，拉取与翻译累计<\/li>/);
  assert.deepEqual(summary.feeds, [
    ["❌<script>source</script>", "0.1s", "0.3s", "0.5s", 2, 0],
    ["✅Second feed", "0.3s", "0.3s", "0.7s", 3, 0],
    ["❌Bad source", "0.1s", "未执行", "0.1s", "—", "—"],
  ]);
  assert.match(html, /<td>❌&lt;script&gt;source&lt;\/script&gt;<\/td>/);
  assert.match(html, /<th scope="col">发现<\/th><th scope="col">报告<\/th>/);
  assert.ok(html.indexOf("总耗时（截至提交前）：") < html.indexOf("耗时热点："));
  assert.doesNotMatch(html, /阶段耗时：|总耗时（截至邮件生成）/);
  assert.ok(html.indexOf("耗时热点：") < html.indexOf("<table><caption>订阅源"));
  assert.doesNotMatch(html, /阶段耗时包含单源耗时，两者不重复相加/);
  assert.doesNotMatch(html, /日志总结/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(renderFetchHtml(result), /抓取失败：Bad source/);
  assert.doesNotMatch(renderFetchHtml(result), /日志总结/);
});

test("validates Codex translation shape without accepting lost or incomplete articles", () => {
  const source = { name: "Source", articles: [{ title: "One", description: "Description" }] };
  assert.deepEqual(parseTranslation('{"name":"中文","articles":[{"title":"标题","description":"摘要"}]}', source), {
    name: "中文", articles: [{ title: "标题", description: "摘要" }],
  });
  assert.throws(() => parseTranslation('{"name":"中文","articles":[]}', source), /结构不符合预期/);
  assert.throws(() => parseTranslation('{"name":"中文","articles":[{"title":"","description":"摘要"}]}', source), /文章翻译不符合预期/);
});
