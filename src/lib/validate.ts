/**
 * Request validation helpers built on Zod.
 *
 * Usage:
 *   const parsed = await validateBody(req, mySchema);
 *   if (parsed.error) return parsed.error;   // 400 with details
 *   const data = parsed.data;                // typed
 *
 *   const q = validateSearchParams(req, myQuerySchema);
 *   if (q.error) return q.error;
 *   const params = q.data;
 */

import { NextRequest, NextResponse } from 'next/server';
import { z, ZodSchema, ZodError } from 'zod';

export type ValidateResult<T> =
  | { data: T; error?: undefined }
  | { data?: undefined; error: NextResponse };

function formatZodError(err: ZodError) {
  return err.issues.map((i) => ({
    path: i.path.join('.') || '(root)',
    message: i.message,
  }));
}

function badRequest(err: ZodError): NextResponse {
  return NextResponse.json(
    { error: 'Invalid request', details: formatZodError(err) },
    { status: 400 },
  );
}

/**
 * Parse and validate a JSON body. Returns either typed data or a 400 response.
 */
export async function validateBody<T>(
  req: NextRequest,
  schema: ZodSchema<T>,
): Promise<ValidateResult<T>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return {
      error: NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }),
    };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { error: badRequest(parsed.error) };
  return { data: parsed.data };
}

/**
 * Validate searchParams. Schema fields should be strings (or unions); use
 * `.transform()` / `.pipe(z.coerce…)` for numeric coercion.
 */
export function validateSearchParams<T>(
  req: NextRequest,
  schema: ZodSchema<T>,
): ValidateResult<T> {
  const obj: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => {
    obj[k] = v;
  });
  const parsed = schema.safeParse(obj);
  if (!parsed.success) return { error: badRequest(parsed.error) };
  return { data: parsed.data };
}

export { z };
