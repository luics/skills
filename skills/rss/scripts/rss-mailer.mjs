#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = process.cwd();
const nodeExecutable = process.env.NODE_EXECUTABLE ?? process.execPath;
const rssCli = path.join(scriptDir, "rss.mjs");
const recipient = process.env.MAIL_TO ?? "luics.xu@gmail.com";
const sender = process.env.MAIL_FROM ?? "luicsxu@163.com";
const timeZone = process.env.REPORT_TIMEZONE ?? "Asia/Shanghai";
const subjectPrefix = process.env.MAIL_SUBJECT_PREFIX ?? "RSS 阅读器";
const dryRun = /^(1|true|yes)$/i.test(process.env.DRY_RUN ?? "");
const feedsPath = process.env.RSS_FEEDS_PATH?.trim();

function timestamp() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date())
    .filter(({ type }) => type !== "literal")
    .reduce((parts, { type, value }) => ({ ...parts, [type]: value }), {});
}

async function fetchHtml(scopes) {
  const arguments_ = [rssCli, "fetch", ...scopes, "--html"];
  if (feedsPath) arguments_.push("--feeds", feedsPath);
  const child = spawn(nodeExecutable, arguments_, {
    cwd: projectDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const html = Buffer.concat(stdout).toString("utf8").trim();
  if (!html) {
    throw new Error(`RSS CLI 未产生 HTML 输出（退出码：${code ?? "未知"}）：${Buffer.concat(stderr).toString("utf8").trim()}`);
  }
  return { code, html, stderr: Buffer.concat(stderr).toString("utf8").trim() };
}

async function sendMail(html, subject) {
  const message = [
    `To: ${recipient}`,
    `From: ${sender}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
  ].join("\n");
  const child = spawn("/usr/sbin/sendmail", ["-f", sender, "-t", "-oi"], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  child.stdin.end(message);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`sendmail exited with code ${code}`)));
  });
}

async function main() {
  const scopes = process.argv.slice(2);
  const run = timestamp();
  const subject = `${subjectPrefix} - ${run.year}-${run.month}-${run.day} ${run.hour}:${run.minute}`;
  const { html, code, stderr } = await fetchHtml(scopes);
  if (stderr) console.warn(stderr);
  if (code !== 0) console.warn(`RSS 抓取以退出码 ${code} 完成；邮件仍包含可用结果和失败状态。`);
  if (dryRun) {
    console.log(`Dry run: generated RSS email for ${recipient} without sending.`);
    return;
  }
  await sendMail(html, subject);
  console.log(`Sent RSS email to ${recipient}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
