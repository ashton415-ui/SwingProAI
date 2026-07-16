// Structured, credential-safe logging. Never pass raw error objects, error
// messages, stack traces, request bodies, headers, or tokens as `details` —
// only a fixed category plus already-validated identifiers (requestId, swingId).
function logSafe(category, details = {}) {
  const entry = { category };
  for (const [key, value] of Object.entries(details)) {
    if (value !== undefined) entry[key] = value;
  }
  console.error(JSON.stringify(entry));
}

export { logSafe };
