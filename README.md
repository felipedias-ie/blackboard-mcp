# blackboard-mcp

An [MCP](https://modelcontextprotocol.io) server for Blackboard Learn (Ultra). Gives Claude, Codex, Cursor and any other MCP client read access to your courses, content, files, grades, deadlines, announcements and discussions, using your own browser session.

```bash
npx blackboard-mcp auth login     # sign in once
npx blackboard-mcp install        # register with your MCP client
```

Then ask your assistant things like:

> *What do I have due this week?*
> *Read me the lecture 4 slides from Machine Learning.*
> *How am I doing across all my courses?*
> *Catch me up, I've been away a week.*

---

## Why this exists

Blackboard's documented REST API requires an OAuth application registered and approved by your institution's Blackboard administrator. Most students and many staff can't get one.

This package targets the internal Ultra API instead: the surface the Blackboard web interface itself calls, authenticated with nothing but a session cookie. It also exposes more than the public API does, including to-do lists, the activity stream, conversations, discussion read state and attendance.

It is read-only in practice, and does not cover quizzes, rubrics or submitting work. See Limitations below.

## Install

Requires Node.js 22.5+. Older versions work but must sign in with `--paste`.

```bash
npm install -g blackboard-mcp
```

Or run it without installing, which is what the generated client config uses:

```bash
npx -y blackboard-mcp
```

## Signing in

```bash
blackboard-mcp auth login
```

That's the whole flow. No URL, no cookies, no DevTools, no password.

It reads the session from the browser you're already signed in to. Blackboard's `BbRouter` cookie is emitted only by Blackboard Learn, so finding it identifies both that you have a session and which instance it belongs to. Candidates are verified against the live API before anything is stored.

```
$ blackboard-mcp auth login

Signed in as Ada Lovelace (a.lovelace@student.example.edu)
Instance:    https://blackboard.example.edu
Imported by: browser (automatic)

Auto-refresh: ENABLED
```

Works with Chrome, Edge, Brave, Chromium, Vivaldi, Opera and Firefox, including multiple profiles. To see what it can find:

```bash
blackboard-mcp auth browsers
```

### You won't have to sign in again

Blackboard sessions expire after about three hours. Two mechanisms avoid re-authenticating:

1. **Keep-alive.** While the server runs it pings Blackboard's session endpoint, resetting the inactivity timer. An idle session never expires.
2. **Silent renewal.** If the session lapses anyway, the institution's SSO redirect chain is replayed against your identity provider. This is what your browser does when you reload after being logged out.

Renewal works because identity provider sessions outlive Blackboard's by weeks or months. `auth login` imports those cookies alongside Blackboard's, so renewal needs no human:

```
GET  /ultra                       -> 302
GET  /                            -> 302
GET  /auth-saml/saml/login        -> 302
GET  login.microsoftonline.com/   -> 200  (auto-submit SAMLResponse)
POST /auth-saml/saml/SSO          -> 302
GET  /ultra                       -> 200  (new session)
```

The implementation follows redirects and resubmits whatever SSO form comes back, so SAML, WS-Federation and Shibboleth all work without provider-specific code.

`auth login` verifies this before reporting `Auto-refresh: ENABLED`, by forcing one full chain through your provider. It then narrows the stored cookies to Blackboard plus your actual provider, discarding anything imported speculatively.

To renew manually:

```bash
blackboard-mcp auth refresh
```

### If browser import can't work

Two cases, both reported with the fallback:

- Chrome 127+ on Windows uses App-Bound Encryption, which by design can't be read by another process.
- Node older than 22.5 lacks the built-in SQLite needed to read cookie stores.

The manual path:

```bash
blackboard-mcp auth login --paste
```

This asks you to paste a "Copy as cURL" from DevTools (Network tab, right-click a request, Copy, Copy as cURL). A pasted request carries only Blackboard's cookies, not your provider's, so these sessions **can't auto-renew** and need signing in again every few hours.

> Blackboard's session cookie is `HttpOnly`, so `document.cookie` can't see it. It only appears on a real request.

Non-interactive:

```bash
BLACKBOARD_COOKIE='BbRouter=...; JSESSIONID=...' \
  blackboard-mcp auth login --url https://blackboard.your-university.edu
```

To check state:

```bash
blackboard-mcp auth status
blackboard-mcp doctor      # full diagnostics
```

## Clients

Auth is **not per client**. `blackboard-mcp auth login` stores one encrypted session in `~/.blackboard-mcp/`, and every client on that machine reads it. Sign in once, then register the server wherever you want it.

```bash
blackboard-mcp auth login                # once, per machine
blackboard-mcp install                   # print config for every known client
blackboard-mcp install cursor --write    # or merge it in automatically
```

`--write` merges into the existing config rather than overwriting it.

### What works where

This is a **local** MCP server. It runs on your machine over stdio, because it reads your browser session and your Blackboard files, neither of which exists on a server somewhere.

| Client | Supported | How |
|---|---|---|
| Claude Code (terminal) | yes | `claude mcp add` |
| Claude Code (desktop app) | yes | same config as the terminal |
| Claude Desktop | yes | `claude_desktop_config.json` |
| Codex CLI | yes | `~/.codex/config.toml` |
| Cursor | yes | `~/.cursor/mcp.json` |
| Windsurf | yes | `~/.codeium/windsurf/mcp_config.json` |
| VS Code (Copilot) | yes | `.vscode/mcp.json` |
| Zed | yes | `settings.json` |
| claude.ai in a browser | **no** | accepts remote servers only |
| Claude for Work / Team / Enterprise (web) | **no** | remote only, plus admin approval |
| ChatGPT (web) | **no** | remote only |
| Codex cloud | **no** | runs server-side, no access to your machine |

The four "no" rows are all the same limitation, explained under [Web clients](#web-clients) below.

### Claude Code

Terminal, and the desktop app's Code tab, share `~/.claude.json`, so one command covers both:

```bash
claude mcp add blackboard --scope user -- npx -y blackboard-mcp
```

`--scope user` makes it available in every project. Drop it to scope the server to the current directory only, or use `--scope project` to write a `.mcp.json` your teammates get too. Restart the desktop app to pick up a change made in the terminal.

Verify:

```bash
claude mcp list
```

### Claude Desktop

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "blackboard": { "command": "npx", "args": ["-y", "blackboard-mcp"] }
  }
}
```

Restart Claude Desktop fully, then look for the tools under the attachments menu.

### Codex CLI

Add to `~/.codex/config.toml`. Note the key is `mcp_servers`, with an underscore:

```toml
[mcp_servers.blackboard]
command = "npx"
args = ["-y", "blackboard-mcp"]
```

Or let the CLI write it:

```bash
codex mcp add blackboard -- npx -y blackboard-mcp
```

### Cursor and Windsurf

Same shape as Claude Desktop, different file:

- Cursor, all projects: `~/.cursor/mcp.json`
- Cursor, one project: `.cursor/mcp.json`
- Windsurf: `~/.codeium/windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "blackboard": { "command": "npx", "args": ["-y", "blackboard-mcp"] }
  }
}
```

### VS Code

`.vscode/mcp.json` in the workspace. The top-level key is `servers`, not `mcpServers`:

```json
{
  "servers": {
    "blackboard": { "command": "npx", "args": ["-y", "blackboard-mcp"] }
  }
}
```

### Zed

In `settings.json`, under `context_servers`:

```json
{
  "context_servers": {
    "blackboard": {
      "source": "custom",
      "command": { "path": "npx", "args": ["-y", "blackboard-mcp"] }
    }
  }
}
```

Zed's schema for this has changed between releases, so if it does not pick the server up, check Zed's current context-server docs. Every other client in this list uses the flat `{"command": "npx", "args": [...]}` form.

### Any other MCP client

The server speaks MCP over stdio. Anything that can launch a subprocess can use it:

```
command: npx
args:    ["-y", "blackboard-mcp"]
```

Optional environment: `BLACKBOARD_MCP_ALLOW_WRITES=1` to permit writes, `BLACKBOARD_MCP_LOG_LEVEL=debug` to troubleshoot. Everything else is read from `~/.blackboard-mcp/`.

To confirm a client can talk to it, run the official inspector:

```bash
npx @modelcontextprotocol/inspector npx -y blackboard-mcp
```

### Web clients

claude.ai in a browser, Claude for Work on the web, ChatGPT on the web and Codex cloud all reach MCP servers over **HTTP, at a public URL**. They cannot launch a process on your laptop, which is the only place your Blackboard session exists. So this server does not work in any of them today, and no configuration change makes it work.

Closing that gap means running the server as a hosted HTTP service, which has a consequence worth being explicit about: that service would hold your Blackboard session, and anyone who reached its URL could read your grades and coursework. It would need its own authentication in front of it, and you would be trusting a host with your student credentials.

If you want that, the honest options are:

1. **Keep it local.** Use a desktop or terminal client. This is what the package is designed for.
2. **Run it yourself** behind a tunnel plus authentication, with the session staying on hardware you control.
3. **Use the official Blackboard REST API instead** for anything hosted. It uses OAuth rather than a borrowed session, which is the right shape for a web integration, though it requires an app your institution's Blackboard administrator has approved.

## Tools

Every course tool takes a `courseId`, an internal id like `_12345_1` rather than the human course code. Get them from `bb_list_courses`.

### Courses and identity
| Tool | Purpose |
|---|---|
| `bb_whoami` | Signed-in user and instance |
| `bb_session_status` | Session validity, expiry, cookies |
| `bb_list_courses` | Enrolled courses with ids, terms, roles. **Start here** |
| `bb_get_course` | Course detail and enabled tools |
| `bb_list_terms` | Academic terms |
| `bb_list_roster` | Participants and their roles |

### Content
| Tool | Purpose |
|---|---|
| `bb_browse_course` | Recursive content tree with folder paths. The main discovery tool |
| `bb_list_content` | One level of a folder |
| `bb_get_content` | Item detail: body text, attached file, link target, due date |
| `bb_search_content` | Search titles and bodies, one course or all |

### Files
| Tool | Purpose |
|---|---|
| `bb_read_file` | Download and extract text. Pages through long PDFs |
| `bb_download_file` | Save a file to disk |
| `bb_list_files` | Every readable document in a course |
| `bb_download_course_files` | Bulk download or archive a course |
| `bb_download_submission` | Files submitted with an assignment attempt |

### Grades
| Tool | Purpose |
|---|---|
| `bb_list_grades` | Grades for one course or all |
| `bb_get_grade_detail` | Score, letter grade, attempts, submissions, instructor feedback |
| `bb_grade_summary` | Per-course standing and averages |
| `bb_review_quiz_attempt` | Read a quiz back question by question, with your answers and scores |
| `bb_submission_status` | Definitive "has this been submitted?", with attempt id and timestamp |

### Deadlines
| Tool | Purpose |
|---|---|
| `bb_todo` | Overdue, due today and upcoming across all courses |
| `bb_calendar` | Calendar events in a date range |
| `bb_course_schedule` | A course's recurring meetings |

### Communication
| Tool | Purpose |
|---|---|
| `bb_announcements` | Announcements with full text, one course or all |
| `bb_activity_stream` | Recent changes across every course |
| `bb_list_conversations` | Course message threads |
| `bb_list_discussions` | Discussion forums, posts and replies |
| `bb_unread_counts` | Unread counts across all courses |
| `bb_attendance` | Attendance records |

### Escape hatch
| Tool | Purpose |
|---|---|
| `bb_raw_request` | Call any Blackboard API path directly |
| `bb_batch_request` | Up to 20 reads in one round trip |
| `bb_list_endpoints` | Every endpoint this server knows |
| `bb_mark_reviewed` | Mark content reviewed (write, off by default) |

### Writes

Off unless `BLACKBOARD_MCP_ALLOW_WRITES=1` is set.

| Tool | Purpose |
|---|---|
| `bb_save_draft` | Save text as a draft, not visible to the instructor, reversible |
| `bb_submit_assignment` | Submit text for grading. Irreversible, requires `confirm: true` |
| `bb_submit_quiz_attempt` | Submit an in-progress quiz. Irreversible, requires `confirm: true` |

Both submit tools have three gates: writes must be enabled, `confirm` must be `true`, and an existing or already-submitted attempt is refused. Each returns Blackboard's receipt id, which is your proof of submission, and flags a late submission.

`bb_submit_quiz_attempt` only changes an attempt's status; answers must already be saved on it. An auto-graded test is scored the moment it is submitted, so there is no undo. Inspect the attempt with `bb_review_quiz_attempt` and get the user's explicit go-ahead first.

Assignment submission is text only, since the file upload flow is not implemented.

**Answering quiz questions is not an available tool.** The endpoint is mapped and `saveQuizAnswer()` exists in the client for anyone scripting deliberately, but it is not exposed to an agent: a model that can read the questions and write the answers is an exam-taking loop, not a data-access one.

The Ultra API is larger than what's wrapped here. `bb_raw_request` is the answer when the tool you need doesn't exist.

## Prompts

Workflows your client surfaces as slash commands:

- `whats_due` deadlines, triaged, with submission status
- `course_briefing` full picture of one course
- `study_pack` find, read and synthesise material on a topic
- `catch_up` everything that changed while you were away
- `grade_report` standing across all courses, with feedback themes
- `find_material` locate a specific file or reading

## Resources

- `blackboard://me` your profile
- `blackboard://courses` course list
- `blackboard://course/{courseId}/outline` full content tree as JSON

## Reading files

`bb_read_file` extracts text from PDF, HTML and plain-text formats, including code, CSV, JSON, Markdown and subtitles.

Long documents are windowed rather than truncated. A PDF returns a page range plus a note telling the model how to continue, so a 300-page course reader is fully readable without flooding the context.

Office formats (`.docx`, `.pptx`, `.xlsx`) and archives can't be extracted. They're ZIP containers needing an unzip implementation Node doesn't ship, and a native dependency would break `npx` installs. They still download fine via `bb_download_file`.

Scanned PDFs with no text layer are detected and reported as needing OCR, rather than returning an empty string that looks like a bug.

### Linked documents

Instructors often publish lecture material as a Google Slides, Docs or Sheets link rather than an uploaded file, leaving no bytes in Blackboard at all. `bb_read_file` resolves these through the provider's export endpoint, so a linked deck reads like an attached file, and `bb_list_files` lists them as course material.

Two constraints, because that URL is written by a third party and arrives as untrusted content:

- **Provider allowlist.** Only Google Docs hosts with a documented export endpoint are fetched. Without this, a pasted link would turn the tool into an arbitrary URL fetcher.
- **No credentials.** These fetches carry no Blackboard session and no Google auth, so only material the instructor already made link-shareable is reachable. A privately shared document reports that plainly instead of returning a sign-in page dressed up as slides.

Formats default to the cheapest to read (`txt` for decks and documents, `csv` for sheets). Pass `format` for `pdf`, `pptx`, `docx` or `xlsx`.

## Timestamps are UTC

Every timestamp the API returns is true UTC, and the `Z` suffix means what it says. This is worth stating because the Ultra web interface renders in the viewer's timezone, which makes "local wall clock stamped as Z" a reasonable suspicion, and that is exactly the wrong conclusion to reach about a deadline.

Two worked examples from a live tenant:

- A deadline shown in the UI as 23:59 Europe/Madrid comes back as `2026-09-16T21:59:00.000Z`. The `:59` is the fingerprint of a correctly stored local 23:59.
- A submission made at 14:07 Madrid reads back as `submitted: 2026-09-18T12:07:53.407Z`.

So convert for display, and never treat the value as local. Telling a student the wrong deadline is this library's highest-consequence silent failure.

## Adapting to your institution

Learn releases and reverse proxies move endpoints around. If something 404s, record a browser session and import it:

```bash
blackboard-mcp har import ~/Downloads/blackboard.har --verbose
```

This detects your instance, compares every real path against the built-in templates, writes corrections to `~/.blackboard-mcp/endpoints.json`, and lists the endpoints your tenant exposes that this package doesn't model. Those stay reachable through `bb_raw_request`.

To record a HAR: DevTools, Network tab, check *Preserve log*, browse Blackboard, then right-click and *Save all as HAR with content*.

> Current Chrome strips cookies from HAR exports, so a HAR can't sign you in. That's a good default, since a HAR with cookies is a credential file. Treat one like a password.

## Security

- **Read-only by default.** Non-GET requests are refused unless `BLACKBOARD_MCP_ALLOW_WRITES=1` is set. Two Blackboard read operations use non-GET verbs (the batch fan-out and the activity stream) and are explicitly allowed.
- **Sessions are encrypted at rest** with AES-256-GCM. The key lives in the macOS Keychain or Linux Secret Service, falling back to a `0600` keyfile. State lives in `~/.blackboard-mcp/`.
- **Browser cookies are read locally only.** Cookie stores are copied, decrypted with a key the OS already grants this user, and never transmitted. Import pulls identity provider cookies broadly at first, since the provider isn't knowable before the SSO chain names it, so the first renewal prunes the stored jar down to Blackboard plus your actual provider.
- **Cookies never leave your instance.** The HTTP client enforces a host allowlist across every redirect hop, so the session can't be sent to a third party even if a redirect or an instructor-pasted link points there.
- **Renewal is scoped by delegation.** The SSO replay only sends cookies to your Blackboard host and to hosts Blackboard's own redirect chain named.
- **Untrusted input is treated as data.** Server-supplied filenames are sanitised before touching the filesystem, and embedded links are accepted only as instance-relative paths.
- `bb_raw_request` is restricted to API path prefixes and rejects traversal.

Your Blackboard account governs what's visible. This server reads exactly what you can read in a browser, and nothing more.

### A note on academic data

Grades, feedback and submissions are confidential personal data, and fall under GDPR in the EU and UK. Downloaded files land on your local disk unencrypted, so mind where they go and prefer the narrowest tool for the question. If you're staff acting on student data rather than your own, check your institution's data-handling policy first.

## Configuration

| Variable | Meaning |
|---|---|
| `BLACKBOARD_URL` | Instance origin, overriding stored config |
| `BLACKBOARD_COOKIE` | Session cookie for non-interactive login |
| `BLACKBOARD_MCP_ALLOW_WRITES` | `1` permits write operations |
| `BLACKBOARD_MCP_DOWNLOAD_DIR` | Where files are saved |
| `BLACKBOARD_MCP_MAX_DOWNLOAD_BYTES` | Per-file ceiling, default 100 MB |
| `BLACKBOARD_MCP_PAGE_SIZE` | Default list page size, default 50 |
| `BLACKBOARD_MCP_LOG_LEVEL` | `silent`, `error`, `warn`, `info` or `debug` |
| `BLACKBOARD_MCP_HOME` | State directory, default `~/.blackboard-mcp` |

## Use as a library

The package is a usable Blackboard SDK on its own:

```ts
import { BlackboardClient } from 'blackboard-mcp';

const bb = await BlackboardClient.create();

for (const m of await bb.listCourses({ availableOnly: true })) {
  console.log(m.course?.displayName);
}

// Recursive content tree, both roots
const items = await bb.walkContents('_12345_1');

// Fan out across courses in one request
const grades = await bb.batch([
  { method: 'GET', relativeUrl: 'v1/courses/_12345_1/gradebook/grades?userId=_1_1' },
]);
```

## CLI

```
blackboard-mcp [serve]                Run the MCP server on stdio (default)
blackboard-mcp auth login             Sign in, importing from your browser
blackboard-mcp auth status            Session and connectivity status
blackboard-mcp auth browsers          List browser profiles and sessions found
blackboard-mcp auth refresh           Renew the session without signing in
blackboard-mcp auth logout [--purge]  Forget the session
blackboard-mcp har import <file>      Learn this tenant's endpoints
blackboard-mcp doctor                 Diagnose configuration
blackboard-mcp install [client]       Register with an MCP client
blackboard-mcp courses                List your courses
blackboard-mcp endpoints [filter]     Show the endpoint map
```

## Troubleshooting

Run `blackboard-mcp doctor` first.

**`NOT_CONFIGURED` or `NOT_AUTHENTICATED`.** Run `blackboard-mcp auth login`.

**`SESSION_EXPIRED`.** The session lapsed and couldn't be renewed silently. If `auth status` shows auto-refresh unavailable, re-run `auth login` without `--paste` to capture identity provider cookies. If it shows enabled, your provider session has itself expired: open Blackboard in a browser, sign in, then `auth login` again.

**"No Blackboard session found in any browser".** Sign in to Blackboard in a browser first. `auth browsers` shows what was scanned.

**"The captured session was rejected".** You copied a request from your SSO provider rather than the Blackboard host, or the tab had already logged out. Copy a request whose URL is your Blackboard hostname.

**A tool 404s.** Your tenant may differ. Run `har import <har> --verbose`, then use `bb_raw_request` for anything unmapped.

**Empty course list.** Courses you hid in Blackboard are excluded by default; pass `includeHidden: true`. Organizations are excluded too; pass `organizations: "include"`.

**`bb_read_file` returns nothing for a PDF.** It's a scan with no text layer and needs OCR. If your institution has Blackboard Ally, the course may offer an accessible alternative format.

**A linked Google deck won't read.** It's shared privately rather than link-shared. Only material the instructor made publicly accessible can be fetched, since no credentials are used.

## Development

```bash
pnpm install
pnpm build
pnpm test            # protocol and unit tests
pnpm typecheck
pnpm inspect         # MCP Inspector against the built server
```

## Limitations

- **Read-only by default.** Assignment submission exists but is off unless you enable writes, and it is text only. Posting discussion replies and sending messages aren't implemented.
- **No file attachments on submissions.** The upload flow has not been captured, so a submission carries text only. Do not rely on it for work that must include a file.
- **Auto-renewal needs a browser-imported session.** A `--paste` session has no identity provider cookies and will expire in a few hours.
- **Office formats** download but don't extract.
- **No OCR** for scanned PDFs.
- **Ultra-oriented.** Courses in the older Classic experience expose less through this API. `bb_raw_request` is the fallback.
- **Unofficial.** This uses an internal API with no stability guarantee. Blackboard may change it without notice, which is why HAR import exists.

## Legal

Not affiliated with, endorsed by, or supported by Anthology Inc. or Blackboard. "Blackboard" and "Blackboard Learn" are trademarks of their respective owners.

This tool accesses your own account with your own credentials, reading the same data your browser shows you. Your institution's acceptable-use policy still applies. Don't use it to access data that isn't yours.

MIT
