# Chat Z.ai integration in CodeSpace 3.13.9

CodeSpace has a **Chat Z.ai** ON/OFF switch in the chat composer. When enabled, CodeSpace starts a local adapter on `127.0.0.1:9876`, discovers the available models, selects the Chat Z.ai provider and sends chat requests through the normal CodeSpace model adapter. Switching OFF restores the previously selected provider.

## Automatic session handling

- **CodeSpace Desktop (3.13.19+):** sign-in happens inside CodeSpace. Use **Run > Open chat.z.ai** or click the Chat Z.ai toggle — the site opens in the CodeSpace Browser panel. Sign in there if the site asks you to; CodeSpace then captures the session token automatically (you will see a "chat.z.ai session captured" note) and the bridge uses it without any external browser window. You do not need to copy or paste a session token.
- On first use without a captured session, older behaviour still applies: CodeSpace opens a dedicated Chrome/Edge window at `chat.z.ai`. Sign in there if the site asks you to.
- CodeSpace stores browser sessions in its own profile folders: the CodeSpace data directory under `BrowserProfile` (the Integrated Browser) and `chat-zai-browser-profile` (the bridge). It does not read or borrow your everyday Chrome/Edge profile.
- The captured token is kept in the agent-server's memory only and is handed to the bridge process privately. It is never returned to the CodeSpace UI or written to application logs.
- If a request receives HTTP 401, the adapter reloads the first-party site without deleting local storage, allowing the website to renew its own session. If the site requires sign-in again, open chat.z.ai in the CodeSpace Browser panel and sign in; the fresh session is captured automatically, and a running bridge picks it up live without a restart.

## Requirements

- Google Chrome or Microsoft Edge installed on the computer running CodeSpace.
- Build dependencies installed with `npm install`; the project includes `puppeteer-core`.
- Internet access to `chat.z.ai` and its frontend CDN.

This uses the website's internal, undocumented web endpoint. It is **not an official Z.ai developer API** and is separate from `https://api.z.ai/api/paas/v4`. Z.ai may change its endpoints or signature module at any time. The site may expire sessions, require reauthentication, apply guest/account limits, or block automation. CodeSpace cannot guarantee unattended renewal if Z.ai requires a fresh login or verification.

The adapter binds only to loopback (`127.0.0.1`) and checks the CodeSpace bridge token on every API request. The session token stays inside the dedicated browser profile and browser context. Protect the Windows account and CodeSpace data directory because the profile contains an authenticated website session.

## Use

1. Launch CodeSpace and connect the Agent Bridge.
2. Click **Chat Z.ai** in the bottom chat toolbar. On first use, a dedicated browser window opens. Sign in at `chat.z.ai` if needed.
3. Wait for CodeSpace to fetch models, choose one in the existing model selector and send a message.
4. On later launches, the saved session is reused automatically. If reauthentication is required, sign in in the browser window; no manual token copying is needed.
5. Click **Chat Z.ai** again to stop the bridge and restore your previous provider.

The manual provider URL remains `http://127.0.0.1:9876/v1`; do not add a developer API key. Image attachments are not enabled for this provider.

Technical reference: [xaoLiu1222/zai-openai-proxy](https://github.com/xaoLiu1222/zai-openai-proxy) describes the reverse-engineered website API/signature approach.
