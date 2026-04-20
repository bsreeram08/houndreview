interface BunFileHandle {
  exists(): Promise<boolean>;
  text(): Promise<string>;
}

interface BunSubprocess {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
}

interface BunServerHandle {
  port: number;
  stop(closeActiveConnections?: boolean): void;
}

interface BunGlobal {
  env: Record<string, string | undefined>;
  file(path: string): BunFileHandle;
  spawn(
    command: string[],
    options?: {
      stdout?: "pipe";
      stderr?: "pipe";
      signal?: AbortSignal;
    },
  ): BunSubprocess;
  serve(options: {
    port: number;
    fetch: (
      request: Request,
      env?: unknown,
      executionCtx?: ExecutionContext,
    ) => Response | Promise<Response>;
  }): BunServerHandle;
}

declare const Bun: BunGlobal;

declare const process: {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  exit(code?: number): never;
};
