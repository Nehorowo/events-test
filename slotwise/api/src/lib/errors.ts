export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code);
  }
}

export const notFound = (what = 'not_found') => new HttpError(404, what);
export const forbidden = (code = 'forbidden') => new HttpError(403, code);
export const badRequest = (code: string, message?: string) => new HttpError(400, code, message);
export const conflict = (code: string, message?: string) => new HttpError(409, code, message);
export const planLimit = (code: string, message?: string) => new HttpError(402, code, message);

/** Postgres exclusion_violation: the no-double-booking constraint fired. */
export function isOverlapError(err: unknown): boolean {
  return (err as { code?: string })?.code === '23P01';
}

export function isUniqueError(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (!constraint || e.constraint === constraint);
}
