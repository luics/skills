#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$script_dir/timestamp-ms.sh"

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <page.html> [public-base-url]" >&2
  exit 64
fi

page=$1
destination=${LOCAL_DESTINATION:-}
destination=${destination%/}
base_url=${2:-https://bryanxu.top/public}
base_url=${base_url%/}

case "$page" in
  *.html) basename=${page##*/}; stem=${basename%.html}; extension=html ;;
  *) echo "The page must have a .html extension." >&2; exit 64 ;;
esac

if [ ! -f "$page" ]; then
  echo "The page file does not exist." >&2
  exit 66
fi

if [ -z "$destination" ]; then
  echo "Set LOCAL_DESTINATION to a writable publish directory." >&2
  exit 64
fi

if [ ! -d "$destination" ] || [ ! -w "$destination" ]; then
  echo "The local publish directory is not writable: $destination" >&2
  exit 73
fi

case "$base_url" in
  http://?*|https://?*) ;;
  *) echo "The public base URL must begin with http:// or https://." >&2; exit 64 ;;
esac

timestamp=$(timestamp_ms)
filename="${stem}-${timestamp}.${extension}"
cp "$page" "$destination/$filename"

url="$base_url/$filename"
curl --fail --silent --show-error --location --max-time 20 --output /dev/null "$url"
printf '%s\n' "$url"
