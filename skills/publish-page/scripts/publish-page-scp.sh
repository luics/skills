#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
. "$script_dir/timestamp-ms.sh"

if [ "$#" -lt 1 ] || [ "$#" -gt 4 ]; then
  echo "Usage: $0 <page.html> [user@host:/remote-directory] [public-base-url] [identity-file]" >&2
  exit 64
fi

page=$1
destination=${2:-${SCP_DESTINATION:-}}
destination=${destination%/}
base_url=${3:-https://bryanxu.top/public}
base_url=${base_url%/}
identity=${4:-${SCP_IDENTIFY:-}}

case "$page" in
  *.html) stem=${page##*/}; stem=${stem%.html} ;;
  *) echo "The page must have a .html extension." >&2; exit 64 ;;
esac

if [ ! -f "$page" ]; then
  echo "The page file does not exist." >&2
  exit 66
fi

case "$destination" in
  *@*:*?*) ;;
  *) echo "The destination must be user@host:/remote-directory." >&2; exit 64 ;;
esac

case "$base_url" in
  http://?*|https://?*) ;;
  *) echo "The public base URL must begin with http:// or https://." >&2; exit 64 ;;
esac

timestamp=$(timestamp_ms)
filename="${stem}-${timestamp}.html"
destination_host=${destination#*@}
destination_host=${destination_host%%:*}
local_directory=${destination#*:}
public_ip=${SCP_PUBLIC_IP:-}

if [ -z "$public_ip" ]; then
  public_ip=$(curl --fail --silent --show-error --max-time 5 https://api.ipify.org 2>/dev/null || :)
fi

if [ -n "$public_ip" ] && [ "$destination_host" = "$public_ip" ]; then
  if [ ! -d "$local_directory" ] || [ ! -w "$local_directory" ]; then
    echo "The local publish directory is not writable: $local_directory" >&2
    exit 73
  fi
  cp "$page" "$local_directory/$filename"
else
  if [ -z "$identity" ]; then
    echo "Set SCP_IDENTIFY or pass an SSH identity file." >&2
    exit 64
  fi

  if [ ! -f "$identity" ]; then
    echo "The SSH identity file does not exist." >&2
    exit 66
  fi

  scp -i "$identity" "$page" "$destination/$filename"
fi

url="$base_url/$filename"
curl --fail --silent --show-error --location --max-time 20 --output /dev/null "$url"
printf '%s\n' "$url"
