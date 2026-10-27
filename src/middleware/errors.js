export function notFound(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.', requestId: req.requestId } });
}

export function errorHandler(err, req, res, _next) {
  // Log request ID and a safe message; never return provider/SQL internals to clients.
  console.error('[api-error]', { requestId: req.requestId, message: err?.message || 'unknown error' });
  if (res.headersSent) return;
  if (err?.message === 'ORIGIN_NOT_ALLOWED') {
    return res.status(403).json({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'This browser origin is not allowed.', requestId: req.requestId } });
  }
  const status = Number(err?.statusCode || err?.status);
  if (status === 400 && err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.', requestId: req.requestId } });
  }
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error. Contact support with the request ID.', requestId: req.requestId } });
}
