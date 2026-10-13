const timestampPrefix = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] /;

function writeLog(method, value) {
  const text = value instanceof Error ? value.stack || value.message : String(value);
  const timestamp = new Date().toISOString();
  for (const line of text.trimEnd().split(/\r?\n/)) {
    console[method](timestampPrefix.test(line) ? line : `[${timestamp}] ${line}`);
  }
}

export const logInfo = (value) => writeLog("log", value);
export const logWarn = (value) => writeLog("warn", value);
export const logError = (value) => writeLog("error", value);
