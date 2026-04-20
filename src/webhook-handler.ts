import { Webhooks } from "@octokit/webhooks";
import type { Context } from "hono";

import { dispatchReview } from "./review-dispatcher";
import type {
  AppConfig,
  ParsedPullRequestEvent,
  PullRequestWebhookPayload,
} from "./types";

const SUPPORTED_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

export async function handleGitHubWebhook(
  c: Context,
  config: AppConfig,
): Promise<Response> {
  try {
    const signature = c.req.header("x-hub-signature-256");
    const eventName = c.req.header("x-github-event")?.toLowerCase();
    const rawBody = await c.req.text();

    if (!signature) {
      return c.json(
        { ok: false, error: "Missing x-hub-signature-256 header." },
        401,
      );
    }

    const webhooks = new Webhooks({ secret: config.githubWebhookSecret });
    const isVerified = await webhooks.verify(rawBody, signature);

    if (!isVerified) {
      return c.json({ ok: false, error: "Invalid webhook signature." }, 401);
    }

    if (eventName !== "pull_request") {
      console.info(`[webhook] skipped event=${eventName ?? "unknown"}`);
      return c.json({ ok: true, skipped: true, reason: "unsupported_event" });
    }

    const payload = parseWebhookPayload(rawBody);
    const parsedEvent = parsePullRequestEvent(payload);

    console.info(
      `[webhook] action=${parsedEvent.action} author=${parsedEvent.author} repo=${parsedEvent.owner}/${parsedEvent.repo} pr=${parsedEvent.pullNumber}`,
    );

    if (!SUPPORTED_ACTIONS.has(parsedEvent.action)) {
      return c.json({ ok: true, skipped: true, reason: "unsupported_action" });
    }

    if (!config.allowedAuthors.includes(parsedEvent.author.toLowerCase())) {
      return c.json({ ok: true, skipped: true, reason: "author_not_allowed" });
    }

    queueMicrotask(() => {
      void dispatchReview(config, parsedEvent);
    });

    return c.json({ ok: true, accepted: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown webhook error";
    console.error(`[webhook] error=${message}`);
    return c.json({ ok: false, error: message }, 400);
  }
}

function parseWebhookPayload(rawBody: string): PullRequestWebhookPayload {
  const parsed = JSON.parse(rawBody) as unknown;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Webhook payload must be a JSON object.");
  }

  return parsed as PullRequestWebhookPayload;
}

function parsePullRequestEvent(
  payload: PullRequestWebhookPayload,
): ParsedPullRequestEvent {
  const installationId = payload.installation?.id;

  if (!payload.pull_request) {
    throw new Error("Missing pull_request object in webhook payload.");
  }

  if (!payload.repository?.owner?.login || !payload.repository?.name) {
    throw new Error("Missing repository owner or name in webhook payload.");
  }

  if (!installationId) {
    throw new Error("Missing installation.id in webhook payload.");
  }

  return {
    action: payload.action,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    pullNumber: payload.pull_request.number,
    author: payload.pull_request.user.login,
    title: payload.pull_request.title,
    body: payload.pull_request.body ?? "",
    htmlUrl: payload.pull_request.html_url,
    installationId,
  };
}
