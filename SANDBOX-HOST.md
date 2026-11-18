# Actual container sandboxes on a Linux host

Android Local and Render Free cannot run Docker containers. A stock Android app
cannot create Linux containers, and Render's free service does not expose a Docker
socket. The only way to get real isolation is to run the CodeSpace backend on (or
connect it to) a Linux machine with Docker Engine or Podman.

This setup gives you real sibling containers:

- the CodeSpace backend runs on the Docker host;
- the backend uses the host's Docker socket to create sandbox containers;
- the Android app connects to the backend over HTTPS with `CODESPACE_API_TOKEN`;
- sandbox files are copied in/out with `docker cp`, so they work across the socket.

The backend container has root-equivalent control of the Docker host. Protect it
with a strong token, TLS, and a firewall. Do not expose port 8787 publicly.

## 1. Prepare the host

Requirements:

- Linux with Docker Engine and the Compose plugin;
- a DNS name pointing at the host (for Caddy HTTPS);
- ports 80 and 443 reachable;
- enough disk for the sandbox images (Node, Python, etc.).

```bash
docker --version
docker compose version
stat -c '%g' /var/run/docker.sock
```

The last command prints the host Docker group GID. Put it in `.env` as
`DOCKER_GID`.

## 2. Copy the backend and configure it

Copy the `codespace-core-3.18.4` folder to the host, then:

```bash
cd codespace-core-3.18.4
cp .env.sandbox-host.example .env
```

Edit `.env`:

```dotenv
CODESPACE_API_TOKEN=<long-random-token>
CODESPACE_DOMAIN=codespace.example.com
DOCKER_GID=<gid-from-stat>
```

Generate a token locally, for example:

```bash
openssl rand -hex 32
```

Do not reuse the token that was previously exposed in chat. Do not commit `.env`.

## 3. Start the backend and HTTPS proxy

```bash
docker compose -f docker-compose.sandbox-host.yml up -d --build
docker compose -f docker-compose.sandbox-host.yml ps
```

Caddy obtains a TLS certificate for `CODESPACE_DOMAIN` automatically. Wait for
DNS and certificate issuance, then test from the host:

```bash
curl -fsS "https://$CODESPACE_DOMAIN/healthz"
```

Expected: a JSON health response.

Test the authenticated info endpoint:

```bash
curl -fsS -H "Authorization: Bearer $CODESPACE_API_TOKEN" \
  "https://$CODESPACE_DOMAIN/info"
```

`/info` should report `bridge:false` (normal for a server backend) and
`ptyAvailable`/`terminalEmulator` depending on the host setup.

## 4. Verify that Docker is visible to the backend

The backend image now includes the Docker CLI. Check the capability report:

```bash
curl -fsS -H "Authorization: Bearer $CODESPACE_API_TOKEN" \
  "https://$CODESPACE_DOMAIN/sandbox/capabilities" | python3 -m json.tool
```

Look for:

```json
"docker": {
  "available": true,
  "healthy": true,
  "isolation": "container (namespaces, cgroups, caps-dropped, read-only rootfs, no network by default)"
}
```

If it is unavailable:

- `docker: command not found` — the image was not rebuilt; run `--build`.
- `permission denied ... /var/run/docker.sock` — `DOCKER_GID` is wrong, or the
  socket is not group-readable. Check `stat -c '%g' /var/run/docker.sock` and
  recreate the service.
- `Cannot connect to the Docker daemon` — the host daemon is stopped, or the
  socket path is different (rootless Docker/Podman). Adjust the volume and
  `DOCKER_HOST` in the compose file.

## 5. Connect the Android app

In CodeSpace:

1. Open the composer sandbox dropdown.
2. Choose **Configure Render…** (it accepts any compatible server URL).
3. Enter:
   - URL: `https://codespace.example.com`
   - token: the `CODESPACE_API_TOKEN` from `.env`
4. Tap **Save and test**.
5. When connected, select **Free server**.
6. Ask the AI to run `sandbox_capabilities`; Docker should now be available.
7. Create a sandbox and run a command.

The app requires an `https://` URL, which is why Caddy (or Cloudflare Tunnel) is
used. A plain `http://` LAN address will not pass the app's server validation.

## 6. Security notes

- The Docker socket is root-equivalent. Anyone with the backend token can create
  containers on the host.
- Keep port 8787 bound to `127.0.0.1`; expose only Caddy on 80/443.
- Use a long random token and rotate it if it is ever exposed.
- The sandbox engine defaults to `--network none`, drops all capabilities except
  the narrowly used `CHOWN`, uses a read-only root filesystem, and enforces
  memory/CPU/PID limits where Docker supports them.
- Sandbox network access is refused unless the sandbox network permission is
  granted and the provider can enforce the requested policy.
- Do not run untrusted code on the host outside a sandbox.

## 7. Alternative: keep Render, use a remote Docker daemon

If you do not want to run the backend on the Docker host, Render can use a remote
Docker daemon over TLS:

- install the Docker CLI in the Render image (already added);
- set `DOCKER_HOST=tcp://docker-host:2376`;
- set `DOCKER_TLS_VERIFY=1` and `DOCKER_CERT_PATH=/certs`;
- upload the client CA/cert/key as Render secret files;
- restrict the daemon to the Render egress IPs and require mutual TLS.

This still creates real containers on the remote host, but the Render free
service sleeps and adds latency. Running the backend on the Docker host is the
simpler and safer option.

## 8. What still will not work

- Docker/Podman inside the Android app itself.
- Docker inside Render's free container without a remote daemon.
- Wasmtime sandboxes unless `wasmtime` is installed on the backend host.
