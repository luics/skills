import { performance } from "node:perf_hooks";
import { logWarn } from "./logger.mjs";

const collectors = new Map();

export function collectTimings(runId) {
  const events = [];
  collectors.set(runId, events);
  return { events, stop: () => collectors.delete(runId) };
}

function fieldsText(fields) {
  return Object.entries(fields).map(([key, value]) =>
    `${key}=${/^[\w.-]+$/.test(String(value)) ? value : JSON.stringify(value)}`
  ).join(" ");
}

// Timing goes to stderr so RSS JSON and report stdout remain parseable.
export function startStage(runId, stage, fields = {}) {
  if (!runId) return () => {};
  const started = performance.now();
  const context = { run_id: runId, stage, ...fields };
  logWarn(fieldsText({ ...context, event: "start" }));
  let finished = false;
  return (status, details = {}) => {
    if (finished) return;
    finished = true;
    const duration = (performance.now() - started).toFixed(1);
    const event = { ...context, event: "end", status, ...details, duration_ms: Number(duration) };
    collectors.get(runId)?.push(event);
    logWarn(`${fieldsText({ ...context, event: "end", status, ...details })} duration_ms=${duration}`);
    return event;
  };
}

export async function measureStage(runId, stage, action, summarize = () => ({})) {
  const finish = startStage(runId, stage);
  try {
    const value = await action();
    const { status = "ok", ...details } = summarize(value);
    finish(status, details);
    return value;
  } catch (error) {
    finish(error.code === "ETIMEDOUT" ? "timeout" : "error");
    throw error;
  }
}
