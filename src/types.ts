export type PullRequestAction = "opened" | "synchronize" | "reopened" | string;

export interface AppConfig {
  githubAppId: string;
  githubAppPrivateKeyPath: string;
  githubWebhookSecret: string;
  port: number;
  openClawBin: string;
  openClawTimeout: number;
  allowedAuthors: string[];
}

export interface GitHubUser {
  login: string;
  type?: string;
}

export interface GitHubRepositoryOwner {
  login: string;
}

export interface GitHubRepository {
  name: string;
  full_name: string;
  owner: GitHubRepositoryOwner;
}

export interface GitHubInstallation {
  id: number;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: GitHubUser;
}

export interface PullRequestWebhookPayload {
  action: PullRequestAction;
  repository: GitHubRepository;
  installation?: GitHubInstallation;
  pull_request: GitHubPullRequest;
}

export interface ParsedPullRequestEvent {
  action: PullRequestAction;
  owner: string;
  repo: string;
  pullNumber: number;
  author: string;
  title: string;
  body: string;
  htmlUrl: string;
  installationId: number;
}

export interface ChangedFileSummary {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRequestReviewContext {
  pr: ParsedPullRequestEvent;
  diff: string;
  files: ChangedFileSummary[];
}

export interface ReviewExecutionResult {
  ok: boolean;
  reviewText: string;
  rawStdout: string;
  rawStderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface CommentTarget {
  owner: string;
  repo: string;
  pullNumber: number;
  installationId: number;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  return {
    githubAppId: requireEnv(env, "GITHUB_APP_ID"),
    githubAppPrivateKeyPath: requireEnv(env, "GITHUB_APP_PRIVATE_KEY_PATH"),
    githubWebhookSecret: requireEnv(env, "GITHUB_WEBHOOK_SECRET"),
    port: parseNumber(env.PORT, 3001, "PORT"),
    openClawBin:
      env.OPENCLAW_BIN?.trim() || "/home/sreeram/.local/bin/openclaw",
    openClawTimeout: parseNumber(env.OPENCLAW_TIMEOUT, 300, "OPENCLAW_TIMEOUT"),
    allowedAuthors: parseAllowedAuthors(env.ALLOWED_AUTHORS),
  };
}

function requireEnv(
  env: Record<string, string | undefined>,
  key: string,
): string {
  const value = env[key]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

function parseNumber(
  rawValue: string | undefined,
  fallback: number,
  key: string,
): number {
  if (!rawValue) {
    return fallback;
  }

  const value = Number.parseInt(rawValue, 10);

  if (Number.isNaN(value) || value <= 0) {
    throw new Error(`Environment variable ${key} must be a positive integer.`);
  }

  return value;
}

function parseAllowedAuthors(rawValue: string | undefined): string[] {
  const authors = (rawValue ?? "bsreeram08")
    .split(",")
    .map((author) => author.trim().toLowerCase())
    .filter((author) => author.length > 0);

  if (authors.length === 0) {
    throw new Error(
      "ALLOWED_AUTHORS must contain at least one GitHub username.",
    );
  }

  return authors;
}
