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
assert_exit 66 "$script" "$test_dir/page.txt"
assert_exit 66 "$script" "$test_dir/missing.html"
assert_exit 66 "$script" "$test_dir"
assert_exit 64 sh -c 'unset SCP_DESTINATION SCP_IDENTIFY; exec "$@"' sh "$script" "$test_dir/page.html"
assert_exit 64 sh -c 'unset SCP_IDENTIFY; SCP_DESTINATION=root@example.test:/srv/public; export SCP_DESTINATION; exec "$@"' sh "$script" "$test_dir/page.html"
assert_exit 64 "$script" "$test_dir/page.html" "not-a-destination"
assert_exit 64 "$script" "$test_dir/page.html" "root@example.test:/srv/public" "ftp://example.test/public"
assert_exit 66 "$script" "$test_dir/page.html" "root@example.test:/srv/public" "https://example.test/public" "$test_dir/missing-key"

assert_exit 64 "$local_script"
assert_exit 64 "$local_script" "$test_dir/page.html" a b
assert_exit 66 "$local_script" "$test_dir/page.txt"
assert_exit 66 "$local_script" "$test_dir/missing.html"
assert_exit 66 "$local_script" "$test_dir"
assert_exit 64 sh -c 'unset LOCAL_DESTINATION; exec "$@"' sh "$local_script" "$test_dir/page.html"
assert_exit 73 env LOCAL_DESTINATION="$test_dir/missing-directory" "$local_script" "$test_dir/page.html"
assert_exit 64 env LOCAL_DESTINATION="$test_dir" "$local_script" "$test_dir/page.html" "ftp://example.test/public"

assert_exit 64 "$oss_script"
assert_exit 64 "$oss_script" "$test_dir/page.html" "not-an-oss-uri"
assert_exit 66 "$oss_script" "$test_dir/page.txt"
assert_exit 66 "$oss_script" "$test_dir/missing.html"
assert_exit 66 "$oss_script" "$test_dir"

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
public_timestamp=${public_url#https://sites.bryanxu.top/page-}
public_timestamp=${public_timestamp%.html}
assert_millisecond_timestamp "$oss_timestamp"
if [ "$public_timestamp" != "$oss_timestamp" ]; then
  echo "Public URL timestamp does not match the OSS URI." >&2
  exit 1
fi

mock_bin="$test_dir/bin"
mkdir "$mock_bin"
cat > "$mock_bin/scp" <<'SCP_MOCK'
#!/bin/sh
set -eu
[ "${SCP_FORBID:-}" != 1 ] || exit 99
[ "$#" -eq 4 ] && [ "$1" = "-i" ] && [ "$2" = "$SCP_IDENTIFY" ] || exit 1
case "$4" in "$SCP_DESTINATION"/*) ;; *) exit 1 ;; esac
if [ -n "${UPLOAD_COPY:-}" ]; then
  cp "$3" "$UPLOAD_COPY"
  printf '%s\n' "$4" > "$UPLOAD_DESTINATION_LOG"
fi
SCP_MOCK
cat > "$mock_bin/ossutil" <<'OSS_MOCK'
#!/bin/sh
set -eu
[ "$#" -eq 3 ] && [ "$1" = cp ] || exit 1
cp "$2" "$UPLOAD_COPY"
printf '%s\n' "$3" > "$UPLOAD_DESTINATION_LOG"
OSS_MOCK
cat > "$mock_bin/curl" <<'CURL_MOCK'
#!/bin/sh
set -eu
if [ "${CURL_FAIL_FIRST:-}" = 1 ] && [ ! -e "$CURL_STATE_FILE" ]; then
  touch "$CURL_STATE_FILE"
  exit 1
fi
if [ "${CURL_EXPECT_LOCAL_FALLBACK:-}" = 1 ]; then
  [ "$1" = "-k" ] && [ "$2" = "--resolve" ] && [ "$3" = "bryanxu.top:443:127.0.0.1" ] || exit 1
fi
head_request=0
for argument do
  [ "$argument" != "--head" ] || head_request=1
done
[ "$head_request" -eq 1 ] || exit 1
[ "${CURL_FORCE_FAIL:-}" != 1 ] || exit 1
CURL_MOCK
chmod 755 "$mock_bin/scp" "$mock_bin/ossutil" "$mock_bin/curl"
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

# Exercise each transport with binary bytes and a range of filename extensions.
for source_name in photo.PNG image.jpg animation.gif drawing.svg clip.mp4 sound.mp3 \
  audio.wav report.pdf notes.txt bundle.tar.gz data.custom README .env; do
  source_file="$test_dir/$source_name"
  printf '\000\001\377media\r\npayload\000' > "$source_file"
  source_stem=$source_name
  source_extension=
  case "$source_name" in
    ?*.*) source_stem=${source_name%.*}; source_extension=".${source_name##*.}" ;;
  esac

  for transport in oss scp local; do
    upload_copy="$test_dir/upload-copy"
    upload_log="$test_dir/upload-destination"
    case "$transport" in
      oss)
        output=$(UPLOAD_COPY="$upload_copy" UPLOAD_DESTINATION_LOG="$upload_log" \
          OSSUTIL="$mock_bin/ossutil" "$oss_script" "$source_file")
        published_url=${output##*
}
        expected_destination="oss://luics-sites"
        ;;
      scp)
        output=$(UPLOAD_COPY="$upload_copy" UPLOAD_DESTINATION_LOG="$upload_log" \
          SCP_DESTINATION="root@example.test:/srv/public" SCP_IDENTIFY="$test_dir/key" \
          PATH="$mock_bin:$PATH" "$script" "$source_file")
        published_url=$output
        expected_destination="root@example.test:/srv/public"
        ;;
      local)
        output=$(LOCAL_DESTINATION="$local_directory" PATH="$mock_bin:$PATH" \
          "$local_script" "$source_file")
        published_url=$output
        ;;
    esac
    published_name=${published_url##*/}
    timestamp=${published_name#"$source_stem"-}
    if [ -n "$source_extension" ]; then
      timestamp=${timestamp%"$source_extension"}
    fi
    assert_millisecond_timestamp "$timestamp"
    if [ "$transport" = local ]; then
      cmp "$source_file" "$local_directory/$published_name"
    else
      cmp "$source_file" "$upload_copy"
      actual_destination=$(cat "$upload_log")
      if [ "$actual_destination" != "$expected_destination/$published_name" ]; then
        echo "Unexpected $transport upload destination: $actual_destination" >&2
        exit 1
      fi
      if [ "$transport" = oss ] && [ "$output" != "$actual_destination
$published_url" ]; then
        echo "OSS output does not match the upload destination." >&2
        exit 1
      fi
    fi
  done
done

assert_exit 1 env LOCAL_DESTINATION="$local_directory" CURL_FORCE_FAIL=1 \
  PATH="$mock_bin:$PATH" "$local_script" "$test_dir/clip.mp4" "https://example.test/public"
assert_exit 1 env SCP_DESTINATION="root@example.test:/srv/public" SCP_IDENTIFY="$test_dir/key" \
  CURL_FORCE_FAIL=1 PATH="$mock_bin:$PATH" "$script" "$test_dir/sound.mp3"
assert_exit 1 env OSSUTIL=false "$oss_script" "$test_dir/photo.PNG"

echo "publish-page file and parameter tests passed"
