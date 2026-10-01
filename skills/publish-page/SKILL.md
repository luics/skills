---
name: publish-page
description: Publish an HTML page with a timestamped filename, using OSS by default or SCP when a public HTTP deployment is needed.
---

Run `scripts/publish-page-oss.sh <page.html>` by default. It uploads to `oss://luics-sites/<name>-<unix-millisecond-timestamp>.<original-ext>`, then prints the OSS URI and `http://sites.bryanxu.top/<filename>`. Optionally pass a different OSS destination prefix as the second argument.

For an SCP deployment with public-URL verification, run `scripts/publish-page-scp.sh <page.html>`. When omitted, its destination and identity come from `SCP_DESTINATION` and `SCP_IDENTIFY`; positional overrides take precedence. If the destination IP is the local public IP, it copies directly to the destination path without SSH/SCP.

Both scripts create `<name>-<unix-millisecond-timestamp>.<original-ext>`. Run `tests/test-publish-page.sh` after changing parameter handling.
