#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$script_dir/timestamp-ms.sh"
. "$script_dir/publish-filename.sh"

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <file> [public-base-url]" >&2
  exit 64
fi

file=$1
destination=${LOCAL_DESTINATION:-}
destination=${destination%/}
base_url=${2:-https://bryanxu.top/public}
base_url=${base_url%/}

case "$file" in
  -*) file="./$file" ;;
esac

if [ ! -f "$file" ]; then
  echo "The source must be an existing regular file." >&2
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

filename=$(publish_filename "$file")
cp "$file" "$destination/$filename"

url="$base_url/$filename"
if ! curl --head --fail --silent --show-error --location --max-time 20 --output /dev/null "$url"; then
  case "$base_url" in
    https://bryanxu.top|https://bryanxu.top/*)
      curl -k --resolve bryanxu.top:443:127.0.0.1 --head --fail --silent --show-error --location --max-time 20 --output /dev/null "$url"
      ;;
    *) exit 1 ;;
  esac
fi
printf '%s\n' "$url"
