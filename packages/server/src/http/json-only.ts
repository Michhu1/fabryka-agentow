import type { RequestHandler } from 'express';

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * CSRF protection without tokens: a cross-site page can only send JSON with a CORS preflight, which we
 * never answer, while forms and `no-cors` fetches are limited to text/plain, urlencoded and multipart.
 * So every mutating request must declare `application/json` — even one without a body.
 */
export const jsonOnly: RequestHandler = (req, res, next) => {
  if (!MUTATING.has(req.method)) return next();
  // Read the header directly: `req.is()` returns null for requests without a body.
  const mediaType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType === 'application/json') return next();
  res.status(415).json({ message: 'Content-Type must be application/json' });
};
