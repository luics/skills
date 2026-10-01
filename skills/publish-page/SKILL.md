---
name: publish-page
description: Publish an HTML page with a timestamped filename, using OSS by default or SCP when a public HTTP deployment is needed.
---

Run `scripts/publish-page-oss.sh <page.html>` by default. It uploads to `oss://luics-sites/<name>-<unix-millisecond-timestamp>.<original-ext>`, then prints the OSS URI and `http://sites.bryanxu.top/<filename>`. Optionally pass a different OSS destination prefix as the second argument.

For an SCP deployment with public-URL verification, run `scripts/publish-page-scp.sh <page.html>`. When omitted, its destination and identity come from `SCP_DESTINATION` and `SCP_IDENTIFY`; positional overrides take precedence. `SCP_IDENTIFY` must name an existing SSH identity file. The script always publishes through SCP.

For a local deployment with public-URL verification, set `LOCAL_DESTINATION` to a writable directory and run `scripts/publish-page-local.sh <page.html>`. It copies the page to that directory; optionally pass a public base URL as the second argument. Its default public base URL is `https://bryanxu.top/public`.

All scripts create `<name>-<unix-millisecond-timestamp>.<original-ext>`. Run `tests/test-publish-page.sh` after changing parameter handling.
