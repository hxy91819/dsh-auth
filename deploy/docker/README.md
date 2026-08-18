# Docker image integration

Build `dsh-auth-0.1.11.tgz` with `pnpm pack --pack-destination dist-pack`, copy the exact tarball beside `Dockerfile.install`, and provide a pinned DSH base image:

```sh
docker build \
  --build-arg DSH_BASE_IMAGE=your-registry/your-dsh-image@sha256:replace-with-digest \
  --build-arg DSH_AUTH_TARBALL=dsh-auth-0.1.11.tgz \
  -f Dockerfile.install .
```

The install step runs with `--network=none`, disables automatic peer installation, and writes the Web profile under `/opt/dsh-home`. The base image supplies the optional Cordis, DSH WebServer, and DSH Settings peers. Run DSH as the same image user that owns this directory, bind it only to loopback when Caddy shares the container, or to an internal non-published container address when Caddy is a separate service. In a two-container deployment, assign Caddy a stable private IP and pass that literal address through `DSH_AUTH_TRUSTED_PROXY_ADDRESSES`; do not trust an entire shared container subnet. Install the matching `dsh-auth-caddy-linux-*@2.11.4-dsh.1` platform package in the image; setup never downloads Caddy.
