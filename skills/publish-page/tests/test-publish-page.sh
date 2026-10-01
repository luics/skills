#!/bin/sh
set -eu

skill_dir=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
script="$skill_dir/scripts/publish-page-scp.sh"
local_script="$skill_dir/scripts/publish-page-local.sh"
oss_script="$skill_dir/scripts/publish-page-oss.sh"
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
touch "$test_dir/page.html"

assert_exit() {
  expected=$1
  shift
  set +e
  "$@" >/dev/null 2>&1
  actual=$?
  set -e
  if [ "$actual" -ne "$expected" ]; then
    echo "Expected exit $expected, got $actual: $*" >&2
    exit 1
  fi
}

assert_millisecond_timestamp() {
  value=$1
  case "$value" in ''|*[!0-9]*) echo "Unexpected timestamp: $value" >&2; exit 1 ;; esac
  if [ "${#value}" -ne 13 ]; then
    echo "Expected a 13-digit millisecond timestamp: $value" >&2
    exit 1
  fi
}

assert_exit 64 "$script"
assert_exit 64 "$script" "$test_dir/page.html" a b c d
assert_exit 64 "$script" "$test_dir/page.txt"
assert_exit 66 "$script" "$test_dir/missing.html"
assert_exit 64 sh -c 'unset SCP_DESTINATION SCP_IDENTIFY; exec "$@"' sh "$script" "$test_dir/page.html"
assert_exit 64 sh -c 'unset SCP_IDENTIFY; SCP_DESTINATION=root@example.test:/srv/public; export SCP_DESTINATION; exec "$@"' sh "$script" "$test_dir/page.html"
assert_exit 64 "$script" "$test_dir/page.html" "not-a-destination"
assert_exit 64 "$script" "$test_dir/page.html" "root@example.test:/srv/public" "ftp://example.test/public"
assert_exit 66 "$script" "$test_dir/page.html" "root@example.test:/srv/public" "https://example.test/public" "$test_dir/missing-key"

assert_exit 64 "$local_script"
assert_exit 64 "$local_script" "$test_dir/page.html" a b
assert_exit 64 "$local_script" "$test_dir/page.txt"
assert_exit 66 "$local_script" "$test_dir/missing.html"
assert_exit 64 sh -c 'unset LOCAL_DESTINATION; exec "$@"' sh "$local_script" "$test_dir/page.html"
assert_exit 73 env LOCAL_DESTINATION="$test_dir/missing-directory" "$local_script" "$test_dir/page.html"
assert_exit 64 env LOCAL_DESTINATION="$test_dir" "$local_script" "$test_dir/page.html" "ftp://example.test/public"

assert_exit 64 "$oss_script"
assert_exit 64 "$oss_script" "$test_dir/page.html" "not-an-oss-uri"
assert_exit 64 "$oss_script" "$test_dir/page.txt"
assert_exit 66 "$oss_script" "$test_dir/missing.html"

set +e
oss_output=$(OSSUTIL=true "$oss_script" "$test_dir/page.html")
oss_status=$?
set -e
if [ "$oss_status" -ne 0 ]; then
  echo "Expected OSS publish output, got exit $oss_status" >&2
  exit 1
fi
oss_uri=$(printf '%s\n' "$oss_output" | sed -n '1p')
public_url=$(printf '%s\n' "$oss_output" | sed -n '2p')
oss_timestamp=${oss_uri#oss://luics-sites/page-}
oss_timestamp=${oss_timestamp%.html}
public_timestamp=${public_url#http://sites.bryanxu.top/page-}
public_timestamp=${public_timestamp%.html}
assert_millisecond_timestamp "$oss_timestamp"
if [ "$public_timestamp" != "$oss_timestamp" ]; then
  echo "Public URL timestamp does not match the OSS URI." >&2
  exit 1
fi

mock_bin="$test_dir/bin"
mkdir "$mock_bin"
printf '%s\n' '#!/bin/sh' '[ "${SCP_FORBID:-}" != 1 ] || exit 99' '[ "$1" = "-i" ] && [ "$2" = "$SCP_IDENTIFY" ] || exit 1' 'case "$4" in "$SCP_DESTINATION"/page-*.html) exit 0 ;; *) exit 1 ;; esac' > "$mock_bin/scp"
printf '%s\n' '#!/bin/sh' 'if [ "${CURL_FAIL_FIRST:-}" = 1 ] && [ ! -e "$CURL_STATE_FILE" ]; then touch "$CURL_STATE_FILE"; exit 1; fi' 'if [ "${CURL_EXPECT_LOCAL_FALLBACK:-}" = 1 ]; then [ "$1" = "-k" ] && [ "$2" = "--resolve" ] && [ "$3" = "bryanxu.top:443:127.0.0.1" ] || exit 1; fi' 'exit 0' > "$mock_bin/curl"
chmod 755 "$mock_bin/scp" "$mock_bin/curl"
touch "$test_dir/key"
scp_output=$(SCP_DESTINATION="root@example.test:/srv/public" SCP_IDENTIFY="$test_dir/key" PATH="$mock_bin:$PATH" "$script" "$test_dir/page.html")
scp_timestamp=${scp_output#https://bryanxu.top/public/page-}
scp_timestamp=${scp_timestamp%.html}
assert_millisecond_timestamp "$scp_timestamp"

local_directory="$test_dir/local-public"
mkdir "$local_directory"
local_output=$(LOCAL_DESTINATION="$local_directory" PATH="$mock_bin:$PATH" "$local_script" "$test_dir/page.html")
local_timestamp=${local_output#https://bryanxu.top/public/page-}
local_timestamp=${local_timestamp%.html}
assert_millisecond_timestamp "$local_timestamp"
if [ ! -f "$local_directory/page-$local_timestamp.html" ]; then
  echo "The local publish script did not copy the page." >&2
  exit 1
fi

curl_state_file="$test_dir/curl-state"
local_fallback_output=$(LOCAL_DESTINATION="$local_directory" CURL_FAIL_FIRST=1 CURL_STATE_FILE="$curl_state_file" CURL_EXPECT_LOCAL_FALLBACK=1 PATH="$mock_bin:$PATH" "$local_script" "$test_dir/page.html")
local_fallback_timestamp=${local_fallback_output#https://bryanxu.top/public/page-}
local_fallback_timestamp=${local_fallback_timestamp%.html}
assert_millisecond_timestamp "$local_fallback_timestamp"
if [ ! -e "$curl_state_file" ]; then
  echo "The local publish fallback did not retry the URL." >&2
  exit 1
fi

echo "publish-page parameter tests passed"
