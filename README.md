# hound-github-app

Auto-reviews GitHub pull requests by receiving GitHub App webhooks, fetching the PR diff, running OpenClaw's `codebase-hound` agent locally through the CLI, and posting the review back as a PR comment.

## What this app does

- Listens for `pull_request` webhooks on `POST /webhook`
- Verifies the GitHub webhook signature
- Filters events so only PRs opened by `bsreeram08` are reviewed
- Uses GitHub App installation auth to fetch the PR diff and changed files
- Runs `openclaw agent --agent codebase-hound --message "..." --json --timeout 300`
- Posts a markdown review comment back to the pull request
- Replaces older `🐕 Codebase Hound` bot comments with the latest review

## Project structure

```text
/home/sreeram/projects/hound-github-app/
├── src/
│   ├── github-client.ts
│   ├── index.ts
│   ├── review-dispatcher.ts
│   ├── types.ts
│   └── webhook-handler.ts
├── .env.example
├── package.json
├── README.md
└── tsconfig.json
```

## GitHub App setup

Create the GitHub App at **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**.

### Required permissions

- `Contents: Read-only`
- `Pull requests: Read & write`

### Required webhook subscription

- Subscribe to the `Pull request` event

### Webhook settings

- Webhook URL: `https://your-server.example.com/webhook`
- Webhook secret: generate a random secret and put the same value in `GITHUB_WEBHOOK_SECRET`

### After creating the app

1. Generate and download a private key (`.pem`)
2. Install the GitHub App on the repository or organization you want to review
3. Copy the App ID into `.env`
4. Point `GITHUB_APP_PRIVATE_KEY_PATH` at the downloaded PEM file

## Environment variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable                      | Meaning                                                     |
| ----------------------------- | ----------------------------------------------------------- |
| `GITHUB_APP_ID`               | Numeric GitHub App ID                                       |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Absolute path to the downloaded GitHub App PEM key          |
| `GITHUB_WEBHOOK_SECRET`       | GitHub webhook secret used for signature verification       |
| `PORT`                        | Local listen port, defaults to `3001`                       |
| `OPENCLAW_BIN`                | Absolute path to the OpenClaw CLI                           |
| `OPENCLAW_TIMEOUT`            | Timeout in seconds for `openclaw agent`                     |
| `ALLOWED_AUTHORS`             | Comma-separated GitHub usernames allowed to trigger reviews |

`OPENCLAW_BIN` must point to a working local OpenClaw CLI binary. This service shells out to that binary directly, so it must run on the same machine, or on a machine that can access the same OpenClaw binary and config.

## OpenClaw requirements

This app depends on a local OpenClaw installation. It does not call an OpenClaw HTTP service.

Before you run this app, make sure all of the following are true:

- `openclaw --version` works on the host machine
- `OPENCLAW_BIN` points to that binary, or another reachable OpenClaw binary
- A `codebase-hound` agent is already installed or registered in OpenClaw
- OpenClaw already has valid provider and model auth configured, so the agent can actually run
- The service has access to the same OpenClaw config and credentials that your CLI uses

Smoke test OpenClaw before wiring GitHub into it:

```bash
openclaw --version
openclaw agent --agent codebase-hound --message "test" --json
```

If the second command fails because the agent is missing, install or register `codebase-hound` in OpenClaw before using this app.

Runtime assumption:

- The review worker runs `openclaw agent --agent codebase-hound --message "..." --json --timeout ...` locally
- If OpenClaw is not installed, not authenticated, or cannot find `codebase-hound`, reviews will fail

## Install and run

```bash
bun install
bun run src/index.ts
```

For development with file watching:

```bash
bun run dev
```

Health check:

```bash
curl http://localhost:3001/health
```

## systemd service

Example `/etc/systemd/system/hound-github-app.service`:

```ini
[Unit]
Description=Hound GitHub App
After=network.target

[Service]
Type=simple
User=sreeram
WorkingDirectory=/home/sreeram/projects/hound-github-app
EnvironmentFile=/home/sreeram/projects/hound-github-app/.env
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Reload and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hound-github-app.service
sudo systemctl status hound-github-app.service
```

## Before going live

Use this checklist before pointing a production GitHub App at the service:

- GitHub App exists with the required permissions and `Pull request` webhook subscription
- Webhook URL points to `/webhook` on the deployed service
- `GITHUB_WEBHOOK_SECRET` matches the GitHub App webhook secret
- `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` are set correctly on the host
- `OPENCLAW_BIN` points to a working OpenClaw CLI on that host
- `openclaw --version` succeeds on that host
- `openclaw agent --agent codebase-hound --message "test" --json` succeeds on that host
- `codebase-hound` is installed or registered in OpenClaw
- OpenClaw provider and model auth are configured on that host
- `ALLOWED_AUTHORS` includes the GitHub usernames allowed to trigger reviews

## Testing with curl

GitHub signs webhook payloads, so raw `curl` tests need a valid HMAC signature.

Example payload:

```json
{
  "action": "opened",
  "installation": { "id": 12345678 },
  "repository": {
    "name": "example-repo",
    "full_name": "bsreeram08/example-repo",
    "owner": { "login": "bsreeram08" }
  },
  "pull_request": {
    "number": 42,
    "title": "Add GitHub review automation",
    "body": "This wires up automatic reviews.",
    "html_url": "https://github.com/bsreeram08/example-repo/pull/42",
    "user": { "login": "bsreeram08" }
  }
}
```

Generate a signature and send it:

```bash
payload='{"action":"opened","installation":{"id":12345678},"repository":{"name":"example-repo","full_name":"bsreeram08/example-repo","owner":{"login":"bsreeram08"}},"pull_request":{"number":42,"title":"Add GitHub review automation","body":"This wires up automatic reviews.","html_url":"https://github.com/bsreeram08/example-repo/pull/42","user":{"login":"bsreeram08"}}}'
secret='replace-with-your-webhook-secret'
signature="sha256=$(printf '%s' "$payload" | openssl dgst -sha256 -hmac "$secret" | sed 's/^.* //')"

curl -X POST http://localhost:3001/webhook \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-Hub-Signature-256: $signature" \
  -d "$payload"
```

## Notes

- This service uses the local OpenClaw CLI directly and does **not** use the async `/hooks/agent` HTTP webhook.
- Reviews are processed asynchronously after webhook acceptance, so GitHub receives a fast `200 OK`.
- Only PR authors listed in `ALLOWED_AUTHORS` trigger reviews.
