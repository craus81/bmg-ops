/**
 * Anthropic Messages API call with retry on 429 (rate limit) and 529
 * (overloaded), honoring the retry-after header. Any other status returns
 * immediately — the caller owns response handling.
 */
export async function callAnthropicWithRetry(
  body: unknown,
  apiKey: string,
  opts?: { maxRetries?: number; extraHeaders?: Record<string, string> },
): Promise<Response> {
  const maxRetries = opts?.maxRetries ?? 3;
  let attempt = 0;
  for (;;) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        ...(opts?.extraHeaders || {}),
      },
      body: JSON.stringify(body),
    });
    if ((response.status === 429 || response.status === 529) && attempt < maxRetries) {
      const retryAfter = parseInt(response.headers.get('retry-after') || '', 10);
      const delayMs = !isNaN(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(2000 * 2 ** attempt, 30000);
      await new Promise(r => setTimeout(r, delayMs));
      attempt++;
      continue;
    }
    return response;
  }
}
