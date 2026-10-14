#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { logInfo, logError } from "./logger.mjs";
import { startStage } from "./timing.mjs";

let FEEDS_PATH = resolve(process.cwd(), "feeds.json");
const EPOCH = "1970-01-01T00:00:00Z";
const DEFAULT_LIMIT = 10;

function usage() {
  return `RSS reader CLI

Usage:
  node scripts/rss.mjs [--feeds <absolute-path>] [fetch] [scope ...] [--limit <count>] [--dry-run] [--markdown|--html|--json]
  node scripts/rss.mjs sendmail [scope ...] [--debug[=true|false]|--no-debug]
  node scripts/rss.mjs feed list [--json]
  node scripts/rss.mjs feed add --id <id> --name <name> --url <rss-url>
  node scripts/rss.mjs feed update <id|url> [--id <id>] [--name <name>] [--url <rss-url>] [--lastest-article-at <iso-utc>] [--disabled <true|false>]
  node scripts/rss.mjs feed remove <id|url> --confirm

Fetch scopes are case-insensitive keywords matched against id, name, and URL, or an exact feed URL.
Without a command, fetch is assumed. Use --json when another program needs the unmodified feed data.`;
}

function fail(message) {
  throw new Error(message);
}

function parseOptions(tokens) {
  const positionals = [];
  const options = new Map();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const [name, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (!name) fail("选项名称不能为空。");
    if (inlineValue !== undefined) {
      options.set(name, inlineValue);
      continue;
    }

    const next = tokens[index + 1];
    if (next && !next.startsWith("--")) {
      options.set(name, next);
      index += 1;
    } else {
      options.set(name, true);
    }
  }

  return { positionals, options };
}

function configureFeedsPath(arguments_) {
  const remaining = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument !== "--feeds" && !argument.startsWith("--feeds=")) {
      remaining.push(argument);
      continue;
    }
    const value = argument === "--feeds" ? arguments_[++index] : argument.slice("--feeds=".length);
    if (!value || value.startsWith("--")) fail("--feeds 需要一个路径。");
    FEEDS_PATH = resolve(value);
  }
  return remaining;
}

function required(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || !value.trim()) {
    fail(`缺少必填选项 --${name}。`);
  }
  return value.trim();
}

function optionString(options, name) {
  const value = options.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    fail(`选项 --${name} 需要一个非空值。`);
  }
  return value.trim();
}

function optionBoolean(options, name) {
  const value = optionString(options, name);
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  fail(`选项 --${name} 只能是 true 或 false。`);
}

function validateUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      fail("RSS/Atom URL 必须使用 HTTP 或 HTTPS。");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("RSS/Atom URL")) throw error;
    fail(`无效的 RSS/Atom URL：${value}`);
  }
  return value;
}

function normalizeTimestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    fail(`无效的 ISO 8601 时间：${value}`);
  }
  return parsed.toISOString();
}

async function readFeeds() {
  let value;
  try {
    value = JSON.parse(await readFile(FEEDS_PATH, "utf8"));
  } catch (error) {
    fail(`无法读取 ${FEEDS_PATH}：${error.message}`);
  }

  if (!Array.isArray(value)) fail("feeds.json 必须是 feed 对象数组。");
  for (const feed of value) {
    if (!feed || typeof feed !== "object") fail("feeds.json 中的每项都必须是对象。");
    if (!["id", "name", "url"].every((key) => typeof feed[key] === "string" && feed[key].trim())) {
      fail("每个 feed 都必须有非空的 id、name 和 url。");
    }
    if (feed.disabled !== undefined && typeof feed.disabled !== "boolean") {
      fail(`feed ${feed.id} 的 disabled 必须是布尔值。`);
    }
    validateUrl(feed.url);
  }
  return value;
}

async function writeFeeds(feeds) {
  const temporaryPath = `${FEEDS_PATH}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(feeds, null, 2)}\n`, "utf8");
  await rename(temporaryPath, FEEDS_PATH);
}

function findExactFeed(feeds, selector) {
  const matches = feeds.filter((feed) => feed.id === selector || feed.url === selector);
  if (matches.length !== 1) {
    fail(matches.length === 0 ? `找不到 id 或 URL 为 “${selector}” 的 feed。` : `选择器 “${selector}” 匹配了多个 feed。`);
  }
  return matches[0];
}

function assertUnique(feeds, key, value, except) {
  if (feeds.some((feed) => feed !== except && feed[key] === value)) {
    fail(`${key === "id" ? "id" : "URL"} 已存在：${value}`);
  }
}

function printFeeds(feeds, asJson) {
  if (asJson) {
    console.log(JSON.stringify(feeds, null, 2));
    return;
  }
  if (feeds.length === 0) {
    logInfo("没有已配置的 feed。");
    return;
  }
  console.log("| ID | 名称 | RSS/Atom URL | 最新文章时间 (UTC) | 状态 |\n| --- | --- | --- | --- | --- |");
  for (const feed of feeds) {
    console.log(`| ${feed.id} | ${feed.name} | ${feed.url} | ${feed.lastestArticleAt || EPOCH} | ${feed.disabled === true ? "已禁用" : "启用"} |`);
  }
}

async function manageFeeds(arguments_) {
  const [action = "list", ...rest] = arguments_;
  const { positionals, options } = parseOptions(rest);
  const feeds = await readFeeds();

  if (action === "list") {
    if (positionals.length) fail("feed list 不接受位置参数。");
    printFeeds(feeds, options.get("json") === true);
    return;
  }

  if (action === "add") {
    if (positionals.length) fail("feed add 不接受位置参数。");
    const id = required(options, "id");
    const name = required(options, "name");
    const url = validateUrl(required(options, "url"));
    assertUnique(feeds, "id", id);
    assertUnique(feeds, "url", url);
    feeds.push({ id, name, url, lastestArticleAt: EPOCH, disabled: false });
    await writeFeeds(feeds);
    logInfo(`已添加 feed：${name}（${id}）。`);
    return;
  }

  if (action === "update" || action === "edit") {
    if (positionals.length !== 1) fail("feed update 需要一个精确的 id 或 URL 选择器。");
    const feed = findExactFeed(feeds, positionals[0]);
    const id = optionString(options, "id");
    const name = optionString(options, "name");
    const url = optionString(options, "url");
    const timestamp = optionString(options, "lastest-article-at");
    const disabled = optionBoolean(options, "disabled");
    if (!id && !name && !url && !timestamp && disabled === undefined) fail("feed update 至少需要一个可修改选项。");
    if (id) {
      assertUnique(feeds, "id", id, feed);
      feed.id = id;
    }
    if (name) feed.name = name;
    if (url) {
      validateUrl(url);
      assertUnique(feeds, "url", url, feed);
      feed.url = url;
    }
    if (timestamp) feed.lastestArticleAt = normalizeTimestamp(timestamp);
    if (disabled !== undefined) feed.disabled = disabled;
    await writeFeeds(feeds);
    logInfo(`已更新 feed：${feed.name}（${feed.id}）。`);
    return;
  }

  if (action === "remove" || action === "delete") {
    if (positionals.length !== 1) fail("feed remove 需要一个精确的 id 或 URL 选择器。");
    if (options.get("confirm") !== true) fail("删除 feed 需要明确确认：--confirm。");
    const feed = findExactFeed(feeds, positionals[0]);
    await writeFeeds(feeds.filter((candidate) => candidate !== feed));
    logInfo(`已删除 feed：${feed.name}（${feed.id}）。`);
    return;
  }

  fail(`未知的 feed 操作：${action}`);
}

function decodeEntities(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (entity, hex, decimal, named) => {
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
      return { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " }[named.toLowerCase()] || entity;
    });
}

function cleanText(value = "") {
  return decodeEntities(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstTagValue(xml, localNames) {
  for (const localName of localNames) {
    const tag = escapeRegExp(localName);
    const expression = new RegExp(`<(?:(?:[\\w.-]+):)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}>`, "i");
    const match = xml.match(expression);
    if (match) return cleanText(match[1]);
  }
  return "";
}

function attributeValue(attributes, name) {
  const expression = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i");
  return attributes.match(expression)?.[2] || "";
}

function extractLink(xml) {
  const links = [];
  const expression = /<link\b([^>]*)>([\s\S]*?)<\/link>|<link\b([^>]*)\/\s*>/gi;
  for (const match of xml.matchAll(expression)) {
    const attributes = match[1] || match[3] || "";
    const href = attributeValue(attributes, "href") || cleanText(match[2] || "");
    if (href) links.push({ href, rel: attributeValue(attributes, "rel") || "alternate" });
  }
  return links.find((link) => link.rel === "alternate")?.href || links[0]?.href || firstTagValue(xml, ["guid"]);
}

function extractEntries(xml) {
  const entries = [];
  for (const tag of ["item", "entry"]) {
    const expression = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
    for (const match of xml.matchAll(expression)) {
      const block = match[1];
      const rawDate = firstTagValue(block, ["publishedAt", "published", "pubDate", "date", "updated", "modified", "created"]);
      const timestamp = Date.parse(rawDate);
      if (Number.isNaN(timestamp)) continue;
      const title = firstTagValue(block, ["title"]);
      const url = extractLink(block);
      if (!title || !url) continue;
      entries.push({
        publishedAt: new Date(timestamp).toISOString(),
        title,
        url,
        description: firstTagValue(block, ["description", "summary", "content", "encoded", "subtitle"]),
      });
    }
  }
  return entries;
}

function decodeResponseBody(body, contentEncoding = "") {
  const encoding = contentEncoding.toLowerCase().split(",")[0].trim();
  if (encoding === "gzip") return gunzipSync(body).toString("utf8");
  if (encoding === "deflate") return inflateSync(body).toString("utf8");
  if (encoding === "br") return brotliDecompressSync(body).toString("utf8");
  return body.toString("utf8");
}

function requestFeedText(url, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error("重定向次数超过 5 次。"));

  return new Promise((resolveRequest, rejectRequest) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const request = client.get(parsed, {
      headers: {
        accept: "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
        "accept-encoding": "gzip, deflate, br",
        "user-agent": "rss-reader-cli/1.0",
      },
    }, (response) => {
      clearTimeout(timeout);
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        resolveRequest(requestFeedText(new URL(response.headers.location, parsed).toString(), redirects + 1));
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        rejectRequest(new Error(`HTTP ${status} ${response.statusMessage || ""}`.trim()));
        return;
      }

      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolveRequest(decodeResponseBody(Buffer.concat(chunks), response.headers["content-encoding"]));
        } catch (error) {
          rejectRequest(error);
        }
      });
      response.on("error", rejectRequest);
    });
    const timeout = setTimeout(() => request.destroy(new Error("请求超时（30 秒）。")), 30_000);
    request.on("error", (error) => {
      clearTimeout(timeout);
      rejectRequest(error);
    });
  });
}

function curlFeedText(url) {
  return new Promise((resolveRequest, rejectRequest) => {
    execFile("curl", ["--compressed", "-fL", "--connect-timeout", "10", "--max-time", "30", "-sS", url], { maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error(String(stderr || "").trim() || error.message || "curl 请求失败。");
        failure.nonRetryable = error.code === 22;
        rejectRequest(failure);
        return;
      }
      resolveRequest(stdout);
    });
  });
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && "code" in error && error.code) return String(error.code);
  if (error instanceof Error && error.name) return error.name;
  return String(error || "未知错误");
}

async function getFeedEntries(feed) {
  const hasProxy = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy);
  const readers = hasProxy ? [curlFeedText, requestFeedText] : [requestFeedText, curlFeedText];
  const errors = [];
  for (const readFeed of readers) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return extractEntries(await readFeed(feed.url));
      } catch (error) {
        errors.push(errorMessage(error));
        if (error?.nonRetryable) throw error;
      }
    }
  }
  throw new Error([...new Set(errors)].join("；") || "请求失败。");
}

function selectFeeds(feeds, scopes) {
  if (scopes.length === 0) {
    return {
      selected: feeds.filter((feed) => feed.disabled !== true),
      disabled: feeds.filter((feed) => feed.disabled === true),
      unmatched: [],
    };
  }
  const selected = new Set();
  const disabled = new Set();
  const unmatched = [];
  for (const scope of scopes) {
    const lowered = scope.toLowerCase();
    const matches = feeds.filter((feed) => feed.url === scope || [feed.id, feed.name, feed.url].some((value) => value.toLowerCase().includes(lowered)));
    if (matches.length === 0) unmatched.push(scope);
    for (const feed of matches) {
      if (feed.disabled === true) disabled.add(feed);
      else selected.add(feed);
    }
  }
  return {
    selected: feeds.filter((feed) => selected.has(feed)),
    disabled: feeds.filter((feed) => disabled.has(feed)),
    unmatched,
  };
}

function parseLimit(value) {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) < 1) {
    fail("--limit 必须是正整数。");
  }
  return Number(value);
}

function descriptionForMarkdown(description) {
  if (!description) return "";
  const chineseCount = (description.match(/[\u3400-\u9fff]/g) || []).length;
  if (chineseCount <= 140 && description.trim().split(/\s+/).length <= 140) return description;
  if (chineseCount > 140) return `${[...description].slice(0, 140).join("")}…`;
  return `${description.trim().split(/\s+/).slice(0, 140).join(" ")}…`;
}

function formatArticleDate(publishedAt) {
  return `[${publishedAt.slice(5, 10).replace("-", ".")}]`;
}

function renderFetchMarkdown(result) {
  const lines = [];
  for (const feed of result.feeds) {
    if (feed.articles.length === 0) continue;
    lines.push(`## ${feed.name}`, "");
    for (const article of feed.articles) {
      lines.push(`* ${formatArticleDate(article.publishedAt)} [${article.title}](${article.url})`);
      const description = descriptionForMarkdown(article.description);
      if (description) lines.push(`     * ${description}`);
    }
    lines.push("");
  }
  if (lines.length === 0) lines.push("没有新文章。");
  if (result.unmatched.length) lines.push(`未匹配的范围：${result.unmatched.join("、")}。`);
  if (result.disabled.length) lines.push(`已禁用，未抓取：${result.disabled.map((feed) => feed.name).join("、")}。`);
  for (const failure of result.failures) lines.push(`抓取失败：${failure.name} — ${failure.error}`);
  return lines.join("\n").trimEnd();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeHref(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? escapeHtml(url.href) : "#";
  } catch {
    return "#";
  }
}

function renderFetchHtml(result, debugSummary = null) {
  const sections = result.feeds
    .filter((feed) => feed.articles.length > 0)
    .map((feed) => `
      <section class="feed">
        <h2>${escapeHtml(feed.name)}</h2>
        <ul class="articles">
          ${feed.articles.map((article) => {
            const description = descriptionForMarkdown(article.description);
            return `<li><time>${escapeHtml(formatArticleDate(article.publishedAt))}</time><a href="${safeHref(article.url)}">${escapeHtml(article.title)}</a>${description ? `<p>${escapeHtml(description)}</p>` : ""}</li>`;
          }).join("\n")}
        </ul>
      </section>`)
    .join("\n");
  const status = [
    ...result.unmatched.map((scope) => `未匹配的范围：${scope}`),
    ...result.disabled.map((feed) => `已禁用，未抓取：${feed.name}`),
    ...result.failures.map((failure) => `抓取失败：${failure.name} — ${failure.error}`),
  ];
  const statusHtml = status.length ? `<section class="status"><h2>状态</h2><ul>${status.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>` : "";
  const debugHtml = debugSummary ? `<section class="status debug"><h2>调试信息</h2><ul>${debugSummary.lines.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}<li>订阅源<ul>${debugSummary.feeds.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></li></ul></section>` : "";
  const content = sections || "<section class=\"empty\"><p>没有新文章。</p></section>";
  const css = `
    body{margin:0;background:#0b1220;color:#dce9fb;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}
    .markdown-body{max-width:900px;margin:auto;padding:8px 6px 0}
    h2{margin:0;border-bottom:1px solid #263b57;padding-bottom:.35em;font-size:17px}
    .feed{margin:0 0 12px;background:#101b2e;border-left:3px solid #1f6feb;padding:8px}
    .articles{margin:8px 0 0;padding:0;list-style:none}.articles li{padding:8px 0;border-bottom:1px solid #263b57}.articles li:last-child{border:0;padding-bottom:0}
    time{display:inline-block;min-width:49px;color:#7ee787;font-variant-numeric:tabular-nums}a{color:#79c0ff;text-decoration:none;font-weight:600}p{margin:4px 0 0;padding-left:8px;color:#aabbd1;font-size:13px}
    .status,.empty{margin:0 0 12px;padding:8px;background:#101b2e;border-left:3px solid #f2cc60}.status h2{color:#f2cc60}.status ul{margin:8px 0 0;padding-left:12px;color:#cbd9eb}.empty{color:#aabbd1}
    .report-footer{box-sizing:border-box;position:relative;left:50%;width:100vw;margin:12px 0 0 -50vw;padding:8px max(6px,calc((100vw - 900px)/2 + 6px));background:#101b2e;color:#86a7cd;font-size:12px}
    @media(max-width:700px){.markdown-body{padding:6px 4px 0}.feed{padding:6px}.articles li{padding:7px 0}}
  `;
  const timestamp = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short", hourCycle: "h23" }).format(new Date());
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><main class="markdown-body">${content}${statusHtml}${debugHtml}</main><footer class="report-footer">获取时间：${escapeHtml(timestamp)}（Asia/Shanghai）</footer></body></html>`;
}

async function fetchFeeds(arguments_) {
  const { positionals: scopes, options } = parseOptions(arguments_);
  const limit = parseLimit(options.get("limit"));
  const dryRun = options.has("dry-run");
  const outputFlags = ["markdown", "html", "json"].filter((name) => options.has(name));
  if (outputFlags.length > 1) fail("--markdown、--html 与 --json 不能同时使用。");
  const feeds = await readFeeds();
  const { selected, disabled, unmatched } = selectFeeds(feeds, scopes);
  const result = { feeds: [], disabled, unmatched, failures: [], dryRun };
  if (process.env.RSS_RUN_ID) result.timings = [];
  let changed = false;

  for (const feed of selected) {
    const finish = startStage(process.env.RSS_RUN_ID, "fetch_feed", { feed_id: feed.id });
    try {
      const entries = await getFeedEntries(feed);
      const cursor = Date.parse(feed.lastestArticleAt || EPOCH);
      const effectiveCursor = Number.isNaN(cursor) ? Date.parse(EPOCH) : cursor;
      const newer = entries.filter((entry) => Date.parse(entry.publishedAt) > effectiveCursor).sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
      const latest = newer[0]?.publishedAt;
      if (latest) {
        feed.lastestArticleAt = latest;
        changed = true;
      }
      result.feeds.push({ id: feed.id, name: feed.name, articles: newer.slice(0, limit), newCount: newer.length });
      const timing = finish("ok", { new_articles: newer.length, report_articles: Math.min(newer.length, limit) });
      if (timing) result.timings.push(timing);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failures.push({ id: feed.id, name: feed.name, error: message });
      const timing = finish(error.code === "ETIMEDOUT" ? "timeout" : "error");
      if (timing) result.timings.push(timing);
    }
  }

  if (changed && !dryRun) await writeFeeds(feeds);
  if (options.has("json")) console.log(JSON.stringify(result, null, 2));
  else if (options.has("html")) console.log(renderFetchHtml(result));
  else console.log(renderFetchMarkdown(result));
  if (result.failures.length) process.exitCode = 1;
}

async function sendMail(arguments_) {
  const mailer = fileURLToPath(new URL("./rss-mailer.mjs", import.meta.url));
  const child = spawn(process.execPath, [mailer, ...arguments_], {
    cwd: process.cwd(),
    env: { ...process.env, RSS_FEEDS_PATH: FEEDS_PATH },
    stdio: "inherit",
  });
  const code = await new Promise((resolveCode, reject) => {
    child.once("error", reject);
    child.once("exit", resolveCode);
  });
  if (code !== 0) process.exitCode = code ?? 1;
}

async function main() {
  const arguments_ = configureFeedsPath(process.argv.slice(2));
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    console.log(usage());
    return;
  }
  if (arguments_[0] === "feed") {
    await manageFeeds(arguments_.slice(1));
    return;
  }
  if (arguments_[0] === "sendmail") {
    await sendMail(arguments_.slice(1));
    return;
  }
  await fetchFeeds(arguments_[0] === "fetch" ? arguments_.slice(1) : arguments_);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    logError(`错误：${error.message}`);
    process.exitCode = 1;
  });
}

export { renderFetchHtml };
