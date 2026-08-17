/**
 * Application error taxonomy.
 *
 * `retryable` drives the background-job retry policy: transient failures back
 * off and retry, permanent validation failures do not.
 */
export type ErrorCategory =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PERMISSION'
  | 'PRECONDITION'
  | 'INTEGRATION'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'INTERNAL';

export interface AppErrorOptions {
  category?: ErrorCategory;
  /** Message safe to show an end user. Never include client data or secrets. */
  userMessage?: string;
  retryable?: boolean;
  cause?: unknown;
  /** Non-sensitive structured context for administrators. */
  context?: Record<string, unknown>;
  httpStatus?: number;
}

const DEFAULT_STATUS: Record<ErrorCategory, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PERMISSION: 403,
  PRECONDITION: 412,
  INTEGRATION: 502,
  RATE_LIMIT: 429,
  TIMEOUT: 504,
  INTERNAL: 500,
};

const RETRYABLE_BY_DEFAULT: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  'INTEGRATION',
  'RATE_LIMIT',
  'TIMEOUT',
]);

export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly userMessage: string;
  readonly retryable: boolean;
  readonly context: Record<string, unknown>;
  readonly httpStatus: number;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.category = options.category ?? 'INTERNAL';
    this.userMessage = options.userMessage ?? 'Something went wrong. An administrator has the technical details.';
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(this.category);
    this.context = options.context ?? {};
    this.httpStatus = options.httpStatus ?? DEFAULT_STATUS[this.category];
  }
}

export class ValidationError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { category: 'VALIDATION', userMessage: message, retryable: false, context });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(what: string, context?: Record<string, unknown>) {
    super(`${what} was not found`, {
      category: 'NOT_FOUND',
      userMessage: `${what} was not found.`,
      retryable: false,
      context,
    });
    this.name = 'NotFoundError';
  }
}

export class PermissionError extends AppError {
  constructor(message = 'You do not have permission to perform this action.', context?: Record<string, unknown>) {
    super(message, { category: 'PERMISSION', userMessage: message, retryable: false, context });
    this.name = 'PermissionError';
  }
}

/** A workflow or policy precondition was not met (e.g. sending before approval). */
export class PreconditionError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { category: 'PRECONDITION', userMessage: message, retryable: false, context });
    this.name = 'PreconditionError';
  }
}

export class IntegrationError extends AppError {
  readonly provider: string;

  constructor(provider: string, message: string, options: AppErrorOptions = {}) {
    super(`[${provider}] ${message}`, {
      category: 'INTEGRATION',
      userMessage: options.userMessage ?? `The ${provider} integration is currently unavailable.`,
      ...options,
    });
    this.name = 'IntegrationError';
    this.provider = provider;
  }
}

export function isRetryable(error: unknown): boolean {
  return error instanceof AppError ? error.retryable : false;
}

export function toUserMessage(error: unknown): string {
  if (error instanceof AppError) return error.userMessage;
  return 'Something went wrong. An administrator has the technical details.';
}

/**
 * A failure described in the vendor's own words, where it gave any.
 *
 * `HTTP 400 for /Notes` says a request was rejected and nothing about why.
 * The vendor's body says which field it objected to, and that body sits in
 * `context.detail` — captured by the client and, until this existed, read by
 * nothing. The verification harness had its own copy of this and the
 * application had none, so an operator saw only "the integration is currently
 * unavailable" and had to go to the logs to learn anything at all.
 *
 * Kept here, next to `toUserMessage`, so the harness and the application cannot
 * disagree about what a vendor failure says.
 *
 * `separator` exists because the two callers format differently: the harness
 * aligns a second line under its column, a screen wants one sentence.
 */
export function describeVendorFailure(error: unknown, separator = ' — '): string {
  const message = error instanceof Error ? error.message : String(error);
  const detail = error instanceof AppError ? error.context.detail : undefined;

  if (typeof detail !== 'string' || detail.trim().length === 0) return message;

  // Collapsed to one line: the body is often pretty-printed JSON, and a wall of
  // it buries the sentence that matters.
  return `${message}${separator}${detail.trim().replace(/\s*\n\s*/g, ' ').slice(0, 400)}`;
}
