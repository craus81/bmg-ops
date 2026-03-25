import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

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
  });
  return _client;
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

// ── Get a file from R2 (for server-side reads) ──
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
