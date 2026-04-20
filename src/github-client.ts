import { Octokit } from "@octokit/rest";

import type {
  AppConfig,
  ChangedFileSummary,
  CommentTarget,
  ParsedPullRequestEvent,
  PullRequestReviewContext,
} from "./types";

const HOUND_MARKER = "## 🐕 Codebase Hound Review";

export async function fetchPullRequestReviewContext(
  config: AppConfig,
  pr: ParsedPullRequestEvent,
): Promise<PullRequestReviewContext> {
  const octokit = await createInstallationOctokit(config, pr.installationId);

  const diffResponse = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    {
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.pullNumber,
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
    },
  );

  const filesResponse = await octokit.rest.pulls.listFiles({
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.pullNumber,
    per_page: 100,
  });

  return {
    pr,
    diff: readDiffResponse(diffResponse.data),
    files: filesResponse.data.map(
      (file) =>
        ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
        }) satisfies ChangedFileSummary,
    ),
  };
}

export async function postReviewComment(
  config: AppConfig,
  target: CommentTarget,
  reviewBody: string,
): Promise<void> {
  const octokit = await createInstallationOctokit(
    config,
    target.installationId,
  );

  await deleteOldBotComments(octokit, target);

  await octokit.rest.issues.createComment({
    owner: target.owner,
    repo: target.repo,
    issue_number: target.pullNumber,
    body: reviewBody,
  });
}

async function deleteOldBotComments(
  octokit: Octokit,
  target: CommentTarget,
): Promise<void> {
  const commentsResponse = await octokit.rest.issues.listComments({
    owner: target.owner,
    repo: target.repo,
    issue_number: target.pullNumber,
    per_page: 100,
  });

  const staleComments = commentsResponse.data.filter((comment) => {
    const body = comment.body ?? "";
    const isBot = comment.user?.type === "Bot";

    return isBot && body.includes(HOUND_MARKER);
  });

  for (const comment of staleComments) {
    await octokit.rest.issues.deleteComment({
      owner: target.owner,
      repo: target.repo,
      comment_id: comment.id,
    });
  }
}

async function createInstallationOctokit(
  config: AppConfig,
  installationId: number,
): Promise<Octokit> {
  const privateKey = await readPrivateKey(config.githubAppPrivateKeyPath);
  const jwt = await createAppJwt(config.githubAppId, privateKey);

  const appOctokit = new Octokit({ auth: jwt });

  const tokenResponse = await appOctokit.request(
    "POST /app/installations/{installation_id}/access_tokens",
    {
      installation_id: installationId,
      headers: {
        authorization: `Bearer ${jwt}`,
      },
    },
  );

  return new Octokit({ auth: tokenResponse.data.token });
}

async function readPrivateKey(path: string): Promise<string> {
  const keyFile = Bun.file(path);

  if (!(await keyFile.exists())) {
    throw new Error(`GitHub App private key not found at ${path}`);
  }

  return keyFile.text();
}

async function createAppJwt(
  appId: string,
  privateKeyPem: string,
): Promise<string> {
  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const issuedAt = Math.floor(Date.now() / 1000) - 60;
  const payload = {
    iat: issuedAt,
    exp: issuedAt + 9 * 60,
    iss: appId,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const normalized = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");

  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

  return bytes.buffer;
}

function base64UrlEncode(value: string | ArrayBuffer): string {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : new Uint8Array(value);

  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function readDiffResponse(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }

  throw new Error("GitHub diff response was not returned as text.");
}
