#!/bin/sh

timestamp_ms() {
  value=$(date +%s%3N 2>/dev/null || :)
  case "$value" in
    ''|*[!0-9]*) ;;
    *)
      if [ "${#value}" -eq 13 ]; then
        printf '%s\n' "$value"
        return 0
      fi
      ;;
  esac

  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import time; print(time.time_ns() // 1_000_000)'
    return 0
  fi

  if command -v perl >/dev/null 2>&1; then
    perl -MTime::HiRes=time -e 'print int(time() * 1000), "\n"'
    return 0
  fi

  echo "A millisecond timestamp requires GNU date, Python 3, or Perl." >&2
  return 69
}
