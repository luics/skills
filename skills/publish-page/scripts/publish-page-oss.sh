#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$script_dir/timestamp-ms.sh"

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <page.html> [oss://bucket/prefix]" >&2
  exit 64
fi

page=$1
destination=${2:-oss://luics-sites}
destination=${destination%/}

case "$page" in
  *.html) basename=${page##*/}; stem=${basename%.html}; extension=html ;;
  *) echo "The page must have a .html extension." >&2; exit 64 ;;
esac

if [ ! -f "$page" ]; then
  echo "The page file does not exist." >&2
  exit 66
fi

case "$destination" in
  oss://?*) ;;
  *) echo "The destination must be an oss:// URI." >&2; exit 64 ;;
esac

timestamp=$(timestamp_ms)
filename="${stem}-${timestamp}.${extension}"
uri="$destination/$filename"
public_url="http://sites.bryanxu.top/$filename"
ossutil_command=${OSSUTIL:-ossutil}

"$ossutil_command" cp "$page" "$uri"
printf '%s\n' "$uri"
printf '%s\n' "$public_url"
