# CodeSpace 3.9.7 — Extensions page: bigger catalog, auto-add, redesigned cards, minimal installed list

## What changed

### 1. Extension catalog expanded from 10 to 33 entries
New real npm MCP packages (each verified against `registry.npmjs.org` before listing):

- **Files:** Google Drive (`@modelcontextprotocol/server-gdrive`)
- **Git & Dev:** Git (`mcp-server-git`)
- **Browser:** Puppeteer (`@modelcontextprotocol/server-puppeteer`),
  Playwright by executeautomation (`@executeautomation/playwright-mcp-server`),
  BrowserTools (`@agentdeskai/browser-tools-mcp`)
- **Web:** Firecrawl (`firecrawl-mcp`), Exa (`exa-mcp-server`),
  DuckDuckGo (`duckduckgo-mcp-server`), Brave Search
  (`@modelcontextprotocol/server-brave-search`), Google Maps
  (`@modelcontextprotocol/server-google-maps`), YouTube Transcript
  (`@kimtaeyoon83/mcp-server-youtube-transcript`)
- **Database:** MySQL (`mcp-mysql-server`), Redis
  (`@modelcontextprotocol/server-redis`), Supabase
  (`@supabase/mcp-server-supabase`), Database/SQLite
  (`@executeautomation/database-server`)
- **Productivity (new category):** Notion (`@notionhq/notion-mcp-server`),
  Obsidian (`mcp-obsidian`), Linear (`mcp-server-linear`),
  Todoist (`todoist-mcp-server`)
- **Communication (new category):** Slack (`@modelcontextprotocol/server-slack`)
- **Developer Tools:** Kubernetes (`mcp-server-kubernetes`),
  Cloudflare (`mcp-server-cloudflare`), Time (`mcp-server-time`)

Entries that need API keys or extra setup carry a "Note:" on the card and in Details.

### 2. Auto-add pack (one click, one approval)
New **Auto-add pack** button in the Extensions view header. It installs the
zero-config starter pack — Memory, Sequential Thinking, Context7, Fetch and
DuckDuckGo — in one go with a single approval dialog, skipping anything already
installed, then refreshes the list. Only zero-config entries were chosen so the
flow needs no follow-up configuration.

### 3. Marketplace card redesign
- Rounded 12px cards with hover lift, accent top border and deeper shadow.
- Category icons now use per-category gradients (two new categories included).
- Descriptions clamp to two lines; package name sits in a pill-styled chip.
- The Install button is a full-width primary action; already-installed entries
  show a green "Installed" state instead of a plain disabled button.

### 4. Installed extensions: minimal cards
Installed extensions now render as compact cards showing **only** the status
dot, the extension name and an **Uninstall** button — no description, no tool
list, no enable checkbox or Retry button. Status/tool/error details moved to
the status dot's hover tooltip. An "Installed extensions" heading was added.

## Files

- `my-chat-agent-v3.html` — EXT_CATALOG expansion, AUTO_PACK auto-add handler,
  renderExt rewrite, ext-market + ext-installed CSS, view markup (Auto-add
  button, Installed section).
- `package.json` — version 3.9.7.
- `pwa/sw.js` — cache version `codespace-pwa-17-ext-catalog-autoadd`.

## Verification

- Inline script passes `node --check`.
- `scripts/test_ext_catalog.js`: 33 unique catalog entries, every category has a
  glyph + CSS color, AUTO_PACK entries all exist in the catalog with zero
  config, installed cards contain exactly one Uninstall button and no
  description text, uninstall confirm wiring works.
- `node verify.cjs` and `node verify-providers.cjs`: all checks PASS.
