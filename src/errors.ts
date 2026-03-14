// src/errors.ts — typed error hierarchy

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/** HTTP 401 from Threads API — trigger token refresh */
export class AuthError extends AppError {
  constructor(message = 'Authentication failed; token may be expired') {
    super(message, 'AUTH_ERROR');
  }
}

/** HTTP 429 — rate limited; skip this run */
export class RateLimitError extends AppError {
  constructor(message = 'Rate limited by Threads API') {
    super(message, 'RATE_LIMIT');
  }
}

/** 5xx or network failure — eligible for retry */
export class TransientError extends AppError {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message, 'TRANSIENT_ERROR');
  }
}

/** Config is incomplete or invalid */
export class ConfigError extends AppError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
  }
}

/** Token is fully expired; re-auth required */
export class TokenExpiredError extends AppError {
  constructor(message = 'Access token expired — run `auth` to re-authenticate') {
    super(message, 'TOKEN_EXPIRED');
  }
}

/** Pipeline overlapping run detected */
export class RunLockError extends AppError {
  constructor(message = 'A pipeline run is already in progress') {
    super(message, 'RUN_LOCK');
  }
}
