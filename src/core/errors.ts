export class ValidationError extends Error {
  readonly name = "ValidationError";
}

export class DeterminismError extends Error {
  readonly name = "DeterminismError";
}

export class AuthenticationError extends Error {
  readonly name = "AuthenticationError";
}

export class TimeoutError extends Error {
  readonly name = "TimeoutError";
}

export class RetryExhaustedError extends Error {
  readonly name = "RetryExhaustedError";
}

