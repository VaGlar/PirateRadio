FROM debian:bookworm-slim

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends icecast2 \
    && rm -rf /var/lib/apt/lists/*

COPY icecast.xml.template /etc/icecast2/icecast.xml.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
    && chown -R icecast2:icecast /etc/icecast2 /var/log/icecast2 /usr/share/icecast2

USER icecast2

EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]
