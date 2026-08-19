FROM node:24.15.0-bookworm

ENV container=docker

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
    ca-certificates \
    dbus \
    iproute2 \
    systemd \
    systemd-sysv \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

STOPSIGNAL SIGRTMIN+3

CMD ["/lib/systemd/systemd", "--system"]
