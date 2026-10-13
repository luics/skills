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
import { encodeMimeHeader, parseTranslation } from "../scripts/rss-mailer.mjs";

const execFileAsync = promisify(execFile);
const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rssCli = path.join(skillDir, "scripts", "rss.mjs");
const rssMailer = path.join(skillDir, "scripts", "rss-mailer.mjs");
const vergeFeedUrl = "https://www.theverge.com/rss/index.xml";

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
  assert.match(stdout, /min-width:49px;color:#7ee787/);

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

  const { stdout } = await execFileAsync(process.execPath, [rssMailer], {
    cwd: workspace,
    env: { ...process.env, DRY_RUN: "1", RSS_FEEDS_PATH: feedsPath, MAIL_TO: "test@example.com", CODEX_EXECUTABLE: fakeCodex },
  });
  assert.match(stdout, /Dry run: generated RSS email for test@example.com without sending/);
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

  const sent = await execFileAsync(process.execPath, [rssMailer], { cwd: workspace, env: environment });
  assert.match(sent.stdout, /Queued RSS email for test@example.com/);
  const message = await readFile(capturedMessage, "utf8");
  assert.match(message, /Subject: =\?UTF-8\?B\?/);
  assert.match(message, /Content-Transfer-Encoding: base64/);
  const encodedHtml = message.split("\r\n\r\n")[1].replaceAll("\r\n", "").trim();
  const html = Buffer.from(encodedHtml, "base64").toString("utf8");
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /中文 Article/);

  await rm(capturedMessage);
  const capturedPrompts = path.join(workspace, "empty-prompts.jsonl");
  const skipped = await execFileAsync(process.execPath, [rssCli, "sendmail"], {
    cwd: workspace,
    env: { ...environment, DRY_RUN: "0", CODEX_CAPTURE_FILE: capturedPrompts },
  });
  assert.match(skipped.stdout, /新文章为 0，跳过邮件发送/);
  await assert.rejects(readFile(capturedMessage), { code: "ENOENT" });
  await assert.rejects(readFile(capturedPrompts), { code: "ENOENT" });

  await runRss(["feed", "update", "mailer", "--lastest-article-at", "1970-01-01T00:00:00Z"], workspace);
  await assert.rejects(
    execFileAsync(process.execPath, [rssMailer], { cwd: workspace, env: { ...environment, SENDMAIL_EXIT: "2" } }),
    (error) => error.code === 1 && /sendmail exited with code 2/.test(error.stderr),
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
      const message = await readFile(capturedMail, "utf8");
      const html = Buffer.from(message.split("\r\n\r\n")[1].replaceAll("\r\n", "").trim(), "base64").toString("utf8");
      assert.match(html, /Original title/);
      assert.match(html, /Original description/);
    });
  }
});

test("validates Codex translation shape without accepting lost or incomplete articles", () => {
  const source = { name: "Source", articles: [{ title: "One", description: "Description" }] };
  assert.deepEqual(parseTranslation('{"name":"中文","articles":[{"title":"标题","description":"摘要"}]}', source), {
    name: "中文", articles: [{ title: "标题", description: "摘要" }],
  });
  assert.throws(() => parseTranslation('{"name":"中文","articles":[]}', source), /结构不符合预期/);
  assert.throws(() => parseTranslation('{"name":"中文","articles":[{"title":"","description":"摘要"}]}', source), /文章翻译不符合预期/);
});
