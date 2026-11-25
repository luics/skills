---
name: publish-page
description: Publish files with timestamped names via OSS, SCP, or local copy. Use when asked to upload or share HTML, images, video, audio, documents, archives, or other files.
---

Accept any regular file, including HTML, images, video, audio, documents, archives, and files without an extension. Upload the original bytes.

Run `scripts/publish-page-oss.sh <file>` by default. It uploads to `oss://luics-sites/<filename>`, then prints the OSS URI and `http://sites.bryanxu.top/<filename>`. Optionally pass a different OSS destination prefix as the second argument.

For an SCP deployment with public-URL verification, run `scripts/publish-page-scp.sh <file>`. When omitted, its destination and identity come from `SCP_DESTINATION` and `SCP_IDENTIFY`; positional overrides take precedence. `SCP_IDENTIFY` must name an existing SSH identity file. The script always publishes through SCP.

For a local deployment with public-URL verification, set `LOCAL_DESTINATION` to a writable directory and run `scripts/publish-page-local.sh <file>`. It copies the file to that directory; optionally pass a public base URL as the second argument. Its default public base URL is `https://bryanxu.top/public`. If direct verification of a `https://bryanxu.top/...` URL fails, it retries against `127.0.0.1` with `curl -k --resolve bryanxu.top:443:127.0.0.1`. SCP and local verification request HTTP headers so large media files are not downloaded during verification.

All scripts create `<name>-<unix-millisecond-timestamp>.<original-ext>`, preserving the extension and its case. Files without an extension use `<name>-<unix-millisecond-timestamp>`; a leading dot alone is not an extension. For example, `photo.PNG`, `clip.mp4`, and `music.mp3` retain `.PNG`, `.mp4`, and `.mp3`. Run `tests/test-publish-page.sh` after changing file naming or parameter handling.
