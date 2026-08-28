import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, GetBucketCorsCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ── R2 Configuration ──
function getR2Config() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME || 'fleetsuite';
  const publicUrl = process.env.R2_PUBLIC_URL; // e.g. https://pub-xxx.r2.dev

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing R2 environment variables (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
  }

  return { accountId, accessKeyId, secretAccessKey, bucket, publicUrl };
}

// ── S3-compatible client for R2 ──
let _client: S3Client | null = null;

export function getR2Client(): S3Client {
  if (_client) return _client;
  const config = getR2Config();
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // AWS SDK ≥3.729 defaults to embedding a CRC32 checksum in every request
    // — including presigned PUT URLs, where it signs the checksum of an
    // EMPTY body (x-amz-checksum-crc32=AAAAAA==). R2 then rejects the real
    // browser upload as a checksum mismatch. WHEN_REQUIRED restores the old
    // behavior: only send checksums when the operation demands one.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return _client;
}

// ── Bucket CORS for browser direct uploads ──
// Presigned PUTs come straight from the browser, so the bucket must answer
// CORS preflights. Without this config R2 403s every OPTIONS request and
// Safari surfaces it as an opaque "Load failed". The rules are permissive on
// purpose: writes are still gated by the short-lived presigned signature and
// the bucket is already publicly readable — CORS is not the security
// boundary here, it just has to stop blocking our own app (prod, Vercel
// previews, localhost dev, and the Capacitor iOS/Android shells, which use
// capacitor://localhost origins no fixed allowlist can anticipate).
const R2_CORS_RULES = [
  {
    AllowedOrigins: ['*'],
    AllowedMethods: ['GET', 'PUT', 'HEAD'],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['etag'],
    MaxAgeSeconds: 3600,
  },
];

let _corsEnsured: Promise<void> | null = null;

// Apply the CORS rules once per server instance, before handing out presigned
// URLs. Failures are logged but never fatal — if the R2 API key only has
// object-level permissions, run `node scripts/setup-r2-cors.mjs` with an
// admin-scoped key instead.
export function ensureR2Cors(): Promise<void> {
  if (_corsEnsured) return _corsEnsured;
  _corsEnsured = (async () => {
    const config = getR2Config();
    const client = getR2Client();
    try {
      const current = await client.send(new GetBucketCorsCommand({ Bucket: config.bucket }))
        .catch((err: any) => {
          // NoSuchCORSConfiguration means "not set yet" — anything else
          // (e.g. AccessDenied) should fall through to the PUT attempt.
          if (err?.name === 'NoSuchCORSConfiguration' || err?.Code === 'NoSuchCORSConfiguration') return null;
          throw err;
        });
      const hasWildcard = current?.CORSRules?.some(r =>
        r.AllowedOrigins?.includes('*') && r.AllowedMethods?.includes('PUT'));
      if (hasWildcard) return;
      await client.send(new PutBucketCorsCommand({
        Bucket: config.bucket,
        CORSConfiguration: { CORSRules: R2_CORS_RULES },
      }));
      console.log('R2 bucket CORS rules applied');
    } catch (err: any) {
      // Let a later request retry rather than caching the failure forever.
      _corsEnsured = null;
      console.error(
        'Could not apply R2 bucket CORS rules (browser uploads will fail preflight until this is fixed).',
        'If this is AccessDenied, the R2 API key lacks bucket-config permission — run scripts/setup-r2-cors.mjs with an Admin Read & Write key.',
        err?.message || err,
      );
    }
  })();
  return _corsEnsured;
}

// ── Upload a file to R2 ──
// prefix maps to the old Supabase bucket name (e.g. 'photos', 'proofs', etc.)
export async function r2Upload(
  prefix: string,
  path: string,
  body: Buffer | Uint8Array | ReadableStream | Blob,
  contentType?: string,
): Promise<{ success: boolean; key: string; publicUrl: string; error?: string }> {
  try {
    const config = getR2Config();
    const client = getR2Client();
    const key = `${prefix}/${path}`;

    await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body instanceof Blob ? Buffer.from(await body.arrayBuffer()) : body,
      ContentType: contentType || 'application/octet-stream',
    }));

    const publicUrl = config.publicUrl
      ? `${config.publicUrl}/${key}`
      : `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${key}`;

    return { success: true, key, publicUrl };
  } catch (err: any) {
    console.error('R2 upload error:', err);
    return { success: false, key: '', publicUrl: '', error: err.message };
  }
}

// ── Delete a file from R2 ──
export async function r2Delete(
  prefix: string,
  path: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const config = getR2Config();
    const client = getR2Client();
    const key = `${prefix}/${path}`;

    await client.send(new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }));

    return { success: true };
  } catch (err: any) {
    console.error('R2 delete error:', err);
    return { success: false, error: err.message };
  }
}

// ── Get public URL for a file ──
export function r2PublicUrl(prefix: string, path: string): string {
  const publicUrl = process.env.R2_PUBLIC_URL;
  const key = `${prefix}/${path}`;
  if (publicUrl) {
    return `${publicUrl}/${key}`;
  }
  // Fallback — shouldn't be used in production
  const accountId = process.env.R2_ACCOUNT_ID || '';
  const bucket = process.env.R2_BUCKET_NAME || 'fleetsuite';
  return `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`;
}

// ── Generate a presigned PUT URL so the browser can upload directly to R2 ──
// Bypasses the Next.js API route body-size limit (~4.5MB on Vercel).
export async function r2PresignPut(
  prefix: string,
  path: string,
  contentType: string,
  expiresIn = 600,
): Promise<{ url: string; key: string; publicUrl: string }> {
  const config = getR2Config();
  const client = getR2Client();
  const key = `${prefix}/${path}`;

  const url = await getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn },
  );

  const publicUrl = config.publicUrl
    ? `${config.publicUrl}/${key}`
    : `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${key}`;

  return { url, key, publicUrl };
}

// ── Generate a presigned GET URL that restores the real filename ──
// Objects are stored under randomized keys (…/<timestamp>-<rand>.<ext>), so a
// download straight off the public URL saves under that random key name. Only
// a signed URL honors the response-content-disposition override — the public
// bucket domain ignores response-* params — hence this instead of r2PublicUrl
// whenever the saved filename matters.
export async function r2PresignGet(
  prefix: string,
  path: string,
  opts: { filename?: string; disposition?: 'inline' | 'attachment'; expiresIn?: number } = {},
): Promise<string> {
  const config = getR2Config();
  const client = getR2Client();
  const key = `${prefix}/${path}`;

  const type = opts.disposition || 'inline';
  let disposition: string = type;
  if (opts.filename) {
    // Plain filename param must stay ASCII and quote-free; the full UTF-8
    // name rides in RFC 5987 filename*, which every current browser prefers.
    const ascii = opts.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const utf8 = encodeURIComponent(opts.filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    disposition = `${type}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
  }

  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
      ResponseContentDisposition: disposition,
    }),
    { expiresIn: opts.expiresIn ?? 600 },
  );
}

// ── Get a file from R2 (for server-side reads) ──
/**
 * Read an object's bytes through R2 credentials instead of its public URL.
 *
 * Server-side callers (PDF assembly, email attachments) must use this rather
 * than fetch()ing r2PublicUrl(). Two reasons, independent of any bucket
 * privacy change: the server already holds credentials, so routing its own
 * reads back out through the public internet is a pointless round trip; and a
 * public fetch that returns an error page yields a 200 with HTML, which then
 * gets embedded as a corrupt image instead of failing. It is also the
 * prerequisite for the bucket ever becoming private -- a public-URL read
 * starts 403ing the moment it does, silently, because these call sites swallow
 * their errors.
 */
export async function r2GetBytes(
  prefix: string,
  path: string,
  maxBytes?: number,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const res = await r2Get(prefix, path);
  if (!res.success || !res.body) return null;
  const body = res.body as any;
  let bytes: Buffer;
  if (typeof body.transformToByteArray === 'function') {
    // AWS SDK v3 attaches this mixin to GetObject bodies.
    bytes = Buffer.from(await body.transformToByteArray());
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    bytes = Buffer.concat(chunks);
  }
  if (bytes.byteLength === 0) return null;
  if (maxBytes && bytes.byteLength > maxBytes) return null;
  return { bytes, contentType: (res.contentType || '').toLowerCase() };
}

export async function r2Get(
  prefix: string,
  path: string,
): Promise<{ success: boolean; body?: ReadableStream; contentType?: string; error?: string }> {
  try {
    const config = getR2Config();
    const client = getR2Client();
    const key = `${prefix}/${path}`;

    const result = await client.send(new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }));

    return {
      success: true,
      body: result.Body as any,
      contentType: result.ContentType,
    };
  } catch (err: any) {
    console.error('R2 get error:', err);
    return { success: false, error: err.message };
  }
}
