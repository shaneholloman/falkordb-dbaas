import { ApiError } from '@falkordb/errors';

/**
 * Extract a human-readable message from an unknown thrown value.
 * Handles ApiError (which does not extend Error), Error, and unknown shapes.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown error';
}

/**
 * Extract the HTTP status code from an unknown thrown value when available.
 * Returns undefined for non-HTTP errors.
 */
export function getErrorStatusCode(error: unknown): number | undefined {
  if (error instanceof ApiError) {
    return error.statusCode;
  }
  return undefined;
}

/**
 * True when the error represents an HTTP 409 Conflict / "already exists" condition.
 * Recognises ApiError.conflict() as well as plain Error messages from non-LDAP sources.
 */
export function isConflictError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.statusCode === 409;
  }
  if (error instanceof Error) {
    return error.message.includes('already exists') || error.message.includes('409');
  }
  return false;
}

/**
 * True when the error represents an HTTP 429 Too Many Requests / rate-limit condition.
 */
export function isRateLimitError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.statusCode === 429;
  }
  if (error instanceof Error) {
    return error.message.includes('429');
  }
  return false;
}
