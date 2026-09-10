#!/bin/sh
set -e

: "${PORT:=8000}"
: "${ICECAST_SOURCE_PASSWORD:?ICECAST_SOURCE_PASSWORD is required}"
: "${ICECAST_ADMIN_PASSWORD:?ICECAST_ADMIN_PASSWORD is required}"
: "${ICECAST_HOSTNAME:=localhost}"

sed \
  -e "s/__ICECAST_SOURCE_PASSWORD__/${ICECAST_SOURCE_PASSWORD}/g" \
  -e "s/__ICECAST_ADMIN_PASSWORD__/${ICECAST_ADMIN_PASSWORD}/g" \
  -e "s/__ICECAST_HOSTNAME__/${ICECAST_HOSTNAME}/g" \
  -e "s/__PORT__/${PORT}/g" \
  /etc/icecast2/icecast.xml.template > /etc/icecast2/icecast.xml

exec icecast2 -c /etc/icecast2/icecast.xml -n
