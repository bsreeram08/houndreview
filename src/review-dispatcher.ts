import {
  fetchPullRequestReviewContext,
  postReviewComment,
} from "./github-client";
import type {
  AppConfig,
  ParsedPullRequestEvent,
  PullRequestReviewContext,
  ReviewExecutionResult,
} from "./types";

export async function dispatchReview(
  config: AppConfig,
  pr: ParsedPullRequestEvent,
): Promise<void> {
  console.info(
    `[review] starting owner=${pr.owner} repo=${pr.repo} pr=${pr.pullNumber}`,
  );

  try {
    const reviewContext = await fetchPullRequestReviewContext(config, pr);
    const prompt = buildReviewPrompt(reviewContext);
    const execution = await runCodebaseHound(config, prompt);
    const reviewBody = execution.ok
      ? formatReviewComment(reviewContext, execution.reviewText)
      : formatFailureComment(reviewContext, execution);

    await postReviewComment(
      config,
      {
        owner: pr.owner,
        repo: pr.repo,
        pullNumber: pr.pullNumber,
        installationId: pr.installationId,
      },
      reviewBody,
    );

    console.info(
      `[review] completed owner=${pr.owner} repo=${pr.repo} pr=${pr.pullNumber} ok=${execution.ok}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[review] failed owner=${pr.owner} repo=${pr.repo} pr=${pr.pullNumber} error=${message}`,
    );

    try {
      await postReviewComment(
        config,
        {
          owner: pr.owner,
          repo: pr.repo,
          pullNumber: pr.pullNumber,
          installationId: pr.installationId,
        },
        [
          "## 🐕 Codebase Hound Review",
          "",
          `PR: #${pr.pullNumber} · ${pr.title}`,
          `Author: @${pr.author}`,
          `URL: ${pr.htmlUrl}`,
          "",
          "⚠️ Review failed before Codebase Hound could return a result.",
          "",
          `Error: ${message}`,
          "",
          `_Generated at ${new Date().toISOString()}_`,
        ].join("\n"),
      );
    } catch (commentError) {
      const commentMessage =
        commentError instanceof Error
          ? commentError.message
          : String(commentError);
      console.error(
        `[review] failed to post failure comment owner=${pr.owner} repo=${pr.repo} pr=${pr.pullNumber} error=${commentMessage}`,
      );
    }
  }
}

function buildReviewPrompt(context: PullRequestReviewContext): string {
  const fileSummary =
    context.files.length > 0
      ? context.files
          .map(
            (file) =>
              `- ${file.filename} (${file.status}) +${file.additions} -${file.deletions} Δ${file.changes}`,
          )
          .join("\n")
      : "- No changed files reported by GitHub";

  return [
    "Review this pull request. Provide verdict: ACK (approve) or NAK (request changes). List all issues by severity.",
    "",
    "## Pull Request Metadata",
    `- Repository: ${context.pr.owner}/${context.pr.repo}`,
    `- Pull Request: #${context.pr.pullNumber}`,
    `- Title: ${context.pr.title}`,
    `- Author: ${context.pr.author}`,
    `- URL: ${context.pr.htmlUrl}`,
    `- Description: ${context.pr.body || "(no description provided)"}`,
    "",
    "## Changed Files",
    fileSummary,
    "",
    "## Full Diff",
    context.diff,
  ].join("\n");
}

async function runCodebaseHound(
  config: AppConfig,
  prompt: string,
): Promise<ReviewExecutionResult> {
  const controller = new AbortController();
  const timeoutMs = config.openClawTimeout * 1000;
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs + 1000);

  const process = Bun.spawn(
    [
      config.openClawBin,
      "agent",
      "--agent",
      "codebase-hound",
      "--message",
      prompt,
      "--json",
      "--timeout",
      String(config.openClawTimeout),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    },
  );

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      streamToString(process.stdout),
      streamToString(process.stderr),
      process.exited,
    ]);

    const parsed = tryParseJson(stdout);
    const reviewText = extractReviewText(parsed);
    const timedOut = exitCode !== 0 && controller.signal.aborted;

    return {
      ok: exitCode === 0 && reviewText.length > 0,
      reviewText:
        reviewText.length > 0 ? reviewText : "No review text returned.",
      rawStdout: stdout,
      rawStderr: stderr,
      exitCode,
      timedOut,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function streamToString(
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (!stream) {
    return "";
  }

  return new Response(stream).text();
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[review] could not parse OpenClaw JSON output: ${message}`);
    return trimmed;
  }
}

function extractReviewText(payload: unknown): string {
  if (typeof payload === "string") {
    return payload.trim();
  }

  if (!payload || typeof payload !== "object") {
    return "";
  }

  const candidateKeys = [
    "reply",
    "content",
    "message",
    "text",
    "output",
    "result",
  ] as const;

  for (const key of candidateKeys) {
    const value = Reflect.get(payload, key);

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  const nestedReply = Reflect.get(payload, "reply");

  if (nestedReply && typeof nestedReply === "object") {
    for (const key of candidateKeys) {
      const value = Reflect.get(nestedReply, key);

      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }

  return JSON.stringify(payload, null, 2);
}

function formatReviewComment(
  context: PullRequestReviewContext,
  reviewText: string,
): string {
  return [
    "## 🐕 Codebase Hound Review",
    "",
    `PR: #${context.pr.pullNumber} · ${context.pr.title}`,
    `Author: @${context.pr.author}`,
    `Repository: ${context.pr.owner}/${context.pr.repo}`,
    `URL: ${context.pr.htmlUrl}`,
    "",
    reviewText,
    "",
    `_Generated at ${new Date().toISOString()}_`,
  ].join("\n");
}

function formatFailureComment(
  context: PullRequestReviewContext,
  execution: ReviewExecutionResult,
): string {
  const failureReason = execution.timedOut
    ? "OpenClaw timed out before returning a completed review."
    : `OpenClaw exited with code ${execution.exitCode}`;

  const detailLines = [
    "## 🐕 Codebase Hound Review",
    "",
    `PR: #${context.pr.pullNumber} · ${context.pr.title}`,
    `Author: @${context.pr.author}`,
    `Repository: ${context.pr.owner}/${context.pr.repo}`,
    `URL: ${context.pr.htmlUrl}`,
    "",
    "⚠️ Review failed.",
    "",
    `Reason: ${failureReason}`,
  ];

  if (execution.rawStderr.trim().length > 0) {
    detailLines.push("", "```text", trimForComment(execution.rawStderr), "```");
  }

  detailLines.push("", `_Generated at ${new Date().toISOString()}_`);

  return detailLines.join("\n");
}

function trimForComment(text: string): string {
  const trimmed = text.trim();

  return trimmed.length > 4000
    ? `${trimmed.slice(0, 4000)}\n...[truncated]`
    : trimmed;
}
