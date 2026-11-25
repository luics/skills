#!/bin/sh

publish_filename() {
  basename=${1##*/}
  stem=$basename
  extension=
  case "$basename" in
    ?*.*) stem=${basename%.*}; extension=".${basename##*.}" ;;
  esac
  timestamp=$(timestamp_ms) || return $?
  printf '%s-%s%s\n' "$stem" "$timestamp" "$extension"
}
