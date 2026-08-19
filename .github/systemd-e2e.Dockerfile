FROM node:24.15.0-bookworm@sha256:f22d6a1f082c02f292e86929b5b0442ac2e5eaf438a5dea9b1566601c3e05940

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
