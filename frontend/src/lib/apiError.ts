/**
 * Phase 20 Part 2: an Error that also carries the HTTP status of the
 * failed request, so the UI can tell a 400 (invalid configuration)
 * from a 422 (radius location not found), a 503 (Google Places not
 * configured) or a network failure -- without parsing message text.
 *
 * It is still a plain `Error` with the backend's own message, so any
 * caller that only reads `err.message` keeps working unchanged.
 */
export class ApiError extends Error {
  /** HTTP status of the response; 0 when no response was received (network failure). */
  readonly status: number;
  /** Set when the backend recorded a failed search row for this request (see POST /api/searches). */
  readonly searchId?: string;

  constructor(message: string, status: number, searchId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.searchId = searchId;
  }
}
