export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

export class RunnerExecutionError extends Error {
  constructor(message: string, public readonly usage: import('./types.js').RunUsage | null) { super(message); this.name = 'RunnerExecutionError'; }
}
