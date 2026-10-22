/** A rule of the domain was broken. `code` is stable and safe to show the client. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 422 = 409,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const notFound = (what: string) => new DomainError("NOT_FOUND", `${what} not found`, 404);
export const forbidden = (message: string, code = "FORBIDDEN") => new DomainError(code, message, 403);
export const invalid = (message: string, code = "INVALID") => new DomainError(code, message, 400);
