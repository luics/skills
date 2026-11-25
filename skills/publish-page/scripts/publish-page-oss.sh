#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$script_dir/timestamp-ms.sh"
. "$script_dir/publish-filename.sh"

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <file> [oss://bucket/prefix]" >&2
  exit 64
fi

file=$1
destination=${2:-oss://luics-sites}
destination=${destination%/}

case "$file" in
  -*) file="./$file" ;;
esac

if [ ! -f "$file" ]; then
  echo "The source must be an existing regular file." >&2
  exit 66
fi

case "$destination" in
  oss://?*) ;;
  *) echo "The destination must be an oss:// URI." >&2; exit 64 ;;
esac

filename=$(publish_filename "$file")
uri="$destination/$filename"
public_url="https://sites.bryanxu.top/$filename"
ossutil_command=${OSSUTIL:-ossutil}

"$ossutil_command" cp "$file" "$uri"
printf '%s\n' "$uri"
printf '%s\n' "$public_url"
