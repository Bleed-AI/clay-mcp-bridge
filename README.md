# Clay MCP Bridge

MCP bridge that exposes Clay table operations to Claude Code via the ClayMate Chrome extension. Forked from `@gtmbase/claymate-mcp-bridge` and maintained by [Bleed-AI](https://github.com/Bleed-AI).

## What This Is

```
Claude Code ──HTTP──> Bridge ──Native Messaging──> ClayMate Extension ──> Clay API
            :12306           stdin/stdout
```

Chrome extensions cannot create HTTP servers. This bridge:

1. Runs an HTTP server on `localhost:12306`
2. Receives MCP tool calls from Claude Code
3. Forwards them to Clay's API using your session cookie (captured by the ClayMate extension)
4. Returns the response back to Claude Code

**Important:** This repo is the bridge server only. You still need the original [ClayMate Chrome extension by GTMBase](https://chromewebstore.google.com/detail/claymate/bjfcanjkepfeijkjpfiikdhkpfbmbgcd) — that extension captures your Clay session cookie and sends it to the bridge.

## Requirements

- Node.js 18+
- [ClayMate Chrome extension](https://chromewebstore.google.com/detail/claymate/bjfcanjkepfeijkjpfiikdhkpfbmbgcd) installed in Chrome
- Logged into [app.clay.com](https://app.clay.com) in the Chrome window with the extension

---

## Windows Setup (Recommended)

The original `--install` flag does not work on Windows (it tries to register a macOS launchd service). Use this approach instead:

### Step 1 — Clone and install

```bat
git clone https://github.com/Bleed-AI/clay-mcp-bridge.git C:\tools\clay-mcp-bridge
cd C:\tools\clay-mcp-bridge
npm install
```

### Step 2 — Start the bridge manually (for testing)

```bat
node C:\tools\clay-mcp-bridge\index.js --server
```

You should see:

```
[Bridge] Clay MCP Bridge v1.0.0 (Bleed-AI)
[Bridge] HTTP server: http://127.0.0.1:12306/mcp
[Bridge] Waiting for session cookie from ClayMate extension...
```

### Step 3 — Auto-start on Windows login

Create a `.bat` file (e.g. `start-clay-bridge.bat`) with:

```bat
@echo off
node C:\tools\clay-mcp-bridge\index.js --server
```

Then put a shortcut to that `.bat` file into your Windows startup folder:

1. Press `Win + R`, type `shell:startup`, press Enter
2. Create a shortcut to `start-clay-bridge.bat` in that folder

The bridge will now start automatically when you log in.

### Step 4 — Configure Claude Code

Add to your `~/.claude.json` (global) or project `.mcp.json`:

```json
{
  "mcpServers": {
    "claymate": {
      "type": "http",
      "url": "http://127.0.0.1:12306/mcp"
    }
  }
}
```

Or via CLI:

```bash
claude mcp add claymate --transport http http://127.0.0.1:12306/mcp
```

Note: Use `"type": "http"` — NOT stdio. This bridge runs as an HTTP server.

### Step 5 — Open Clay in Chrome

Open [app.clay.com](https://app.clay.com) in Chrome with the ClayMate extension active. The extension will automatically push your session cookie to the bridge. Check the bridge terminal — you will see `[Bridge] Session cookie updated`.

---

## Mac / Linux Setup

```bash
# Clone and run directly
git clone https://github.com/Bleed-AI/clay-mcp-bridge.git
cd clay-mcp-bridge
npm install
node index.js --server
```

Or use npx (runs from npm without cloning):

```bash
npx @bleed-ai/clay-mcp-bridge --server
```

Auto-start on macOS via launchd:

```bash
node index.js --install   # installs launchd plist + native messaging host
```

Then configure Claude Code the same way as Windows (Step 4 above).

---

## Health Check

Once the bridge is running and the ClayMate extension has pushed a cookie, verify with:

```bash
curl http://127.0.0.1:12306/health
```

Expected response:

```json
{ "status": "ok", "version": "1.0.0", "hasSession": true, "sessionUpdatedAt": "..." }
```

---

## Bug Fixes vs Original

This fork includes two bug fixes over `@gtmbase/claymate-mcp-bridge@1.0.0`:

**Bug 1 — Missing `Content-Length` on DELETE requests**

The original `clayRequest` function wrote a body for DELETE calls but never set `Content-Length`. Clay's API silently dropped the body, causing `"Field 'recordIds' - Required"` errors on any DELETE operation. Fixed by setting `Content-Length` before writing the body.

**Bug 2 — `clay_delete_all_rows` sent an unsupported `deleteAll` flag**

Clay's API has no `deleteAll` flag — it requires explicit record IDs. The original implementation sent `{ deleteAll: true, viewId: ... }` which Clay ignored. Fixed by first fetching all record IDs from the view, then deleting them explicitly by ID.

---

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `clay_get_status` | Check bridge connection status |
| `clay_list_workspaces` | List all Clay workspaces |
| `clay_get_table` | Get table schema and columns |
| `clay_get_rows` | Fetch record IDs from a view |
| `clay_add_row` | Add a new row to a table |
| `clay_run_enrichment` | Run an enrichment column on records |
| `clay_count_rows` | Get row count for a table |
| `clay_list_sources` | List data sources on a table |
| `clay_list_resources` | List all resources in a workspace |
| `clay_search_resources` | Search resources by name |
| `clay_create_folder` | Create a folder in a workspace |
| `clay_delete_folder` | Delete a folder |
| `clay_create_workbook` | Create a workbook |
| `clay_delete_workbook` | Delete a workbook |
| `clay_delete_rows` | Delete specific rows by record ID |
| `clay_delete_all_rows` | Delete all rows in a view (bug-fixed) |
| `clay_add_webhook` | Add a webhook source to a table |
| `clay_delete_source` | Delete a data source |
| `clay_list_owners` | List workspace users and permissions |
| `clay_get_credit_usage` | Get workspace credit usage |
| `clay_list_integrations` | List connected integrations |
| `clay_export_table_data` | Export table data to a local JSON file |

---

## Troubleshooting

**`hasSession: false` after opening Clay**
- Make sure the ClayMate extension is installed and active in Chrome
- Reload the [app.clay.com](https://app.clay.com) tab — the extension pushes the cookie on page load

**`Connection refused on port 12306`**
- The bridge is not running — start it with `node index.js --server`
- On Windows, check that your `.bat` shortcut launched correctly

**`Field 'recordIds' - Required` errors**
- Update to this fork — this is Bug 1 fixed above

**`--install` flag fails on Windows**
- Do not use `--install` on Windows — follow the Windows Setup section above instead
