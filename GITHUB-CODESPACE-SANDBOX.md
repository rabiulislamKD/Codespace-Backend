# GitHub Codespaces as the third sandbox

CodeSpace Android now has three explicit sandbox providers:

1. **Local** — runs in the app's private Android workspace.
2. **Render** — your existing free Render Agent Server. It is unchanged.
3. **GitHub Codespace** — the CodeSpace agent server runs inside a GitHub
   Codespace, so commands, files and optional Docker containers execute on that
   Codespace's Linux machine.

The app does not create or bill Codespaces for you. You create the Codespace,
start the agent server, make port 8787 public, and paste its URL and token into
**Sandbox → GitHub Codespace → Configure GitHub…**.

## 1. Put the backend in a GitHub repository

Push the contents of this folder (`codespace-core-3.18.4`) to a GitHub
repository. The included `.devcontainer/` starts the server automatically.

If you only want command/file execution and do not need container sandboxes,
the Docker feature is optional. Remove the `docker-in-docker` feature from
`.devcontainer/devcontainer.json` in that case.

## 2. Create the Codespace

1. On GitHub, open the repository.
2. Choose **Code → Codespaces → Create codespace on main**.
3. Wait for the devcontainer to build. The first Docker-in-Docker build can take
   several minutes.
4. The `postStartCommand` runs `.devcontainer/start-codespace-backend.sh` and
   prints the public URL pattern and where to read the token.

The script generates a token on first run and stores it at
`~/.codespace-agent/token`. To choose the token yourself, add a Codespaces
secret named `CODESPACE_API_TOKEN` (repository or user secret) before creating
the Codespace. Do not commit a token to the repository.

## 3. Make the port public

1. Open the **Ports** panel in the Codespace.
2. Find port **8787** (label: CodeSpace Agent Server).
3. Right-click it → **Port Visibility** → **Public**.
4. Copy the forwarded URL. It looks like:

   `https://<codespace-name>-8787.app.github.dev`

A public port means anyone with the URL and token can reach the agent server.
Keep the token secret and stop/delete the Codespace when you are finished.

## 4. Verify from the Codespace

```bash
curl -fsS http://127.0.0.1:8787/healthz
TOKEN="$(cat "$HOME/.codespace-agent/token")"
curl -fsS -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}' http://127.0.0.1:8787/info
```

The response should include a workspace root. If you enabled
Docker-in-Docker, also check:

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}' http://127.0.0.1:8787/sandbox/capabilities
```

## 5. Connect the Android app

1. Install the v21 APK.
2. Open the sandbox selector in the composer header.
3. Choose **GitHub Codespace**. If it is not configured, the app opens the
   GitHub Codespace dialog automatically.
4. Paste the `https://…-8787.app.github.dev` URL and the token.
5. Tap **Save and test**. The app calls `/info` with the token before switching.
   A failed test leaves the previous working provider active instead of handing
   the IDE a blank bridge.
6. To change or remove the credentials later, choose **Configure GitHub…** in
   the selector.

## About Vercel

Normal Vercel deployments are serverless/static HTTP functions: there is no
persistent shell, PTY, Docker socket or long-lived workspace for this agent
server. Vercel Sandbox is a separate API product and would need a real provider
adapter in `sandbox-manager.js`; it is not a drop-in URL like Render or a
Codespace. The GitHub Codespace option is the practical third sandbox today.

## Security notes

- The agent server has the same file and command access as the Codespace user.
- With Docker-in-Docker enabled, it can create sibling containers inside the
  Codespace. Do not expose the port publicly longer than necessary.
- The Android app stores the URL and token in app-private preferences.
- Rotate the token by deleting `~/.codespace-agent/token`, stopping the server,
  and restarting the Codespace; then update the app.
