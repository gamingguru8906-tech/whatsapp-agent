// Anti-spam without a login: honeypot field, per-IP rate limit (Cloudflare binding) and Turnstile.
export const clientIp = request => request.headers.get('cf-connecting-ip') ?? 'local';

export async function verifyTurnstile(token, ip, secret, fetchImpl = fetch) {
  if (!token) return false;
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', String(token));
  if (ip && ip !== 'local') body.append('remoteip', ip);
  try {
    const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

export async function withinRateLimit(env, ip) {
  if (!env.RATE_LIMITER) return true;
  try {
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    return success;
  } catch {
    return true; // a limiter outage should not block real visitors
  }
}
