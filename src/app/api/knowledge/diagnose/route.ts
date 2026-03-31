import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { r2Get } from '@/lib/r2';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET() {
  const results: Record<string, any> = {};

  // 1. Check env vars
  results.env = {
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    anthropicKeyPrefix: process.env.ANTHROPIC_API_KEY?.substring(0, 10) + '...',
    hasR2AccountId: !!process.env.R2_ACCOUNT_ID,
    hasR2AccessKey: !!process.env.R2_ACCESS_KEY_ID,
    hasR2SecretKey: !!process.env.R2_SECRET_ACCESS_KEY,
    r2Bucket: process.env.R2_BUCKET_NAME || '(default: fleetsuite)',
    r2PublicUrl: process.env.R2_PUBLIC_URL || '(not set)',
    nextPublicR2Url: process.env.NEXT_PUBLIC_R2_PUBLIC_URL || '(not set)',
  };

  // 2. Get a sample doc from the DB
  const { data: docs, error: dbErr } = await supabase
    .from('knowledge_docs')
    .select('id, title, file_name, file_path, file_type, file_size')
    .not('file_path', 'is', null)
    .limit(3);

  if (dbErr) {
    results.db = { error: dbErr.message };
  } else {
    results.db = { docCount: docs?.length || 0, samples: docs };
  }

  // 3. Try to download the first doc from R2
  if (docs && docs.length > 0) {
    const testDoc = docs[0];
    results.r2Test = { docId: testDoc.id, filePath: testDoc.file_path };

    try {
      const r2Result = await r2Get('knowledge-files', testDoc.file_path);
      results.r2Test.success = r2Result.success;
      results.r2Test.hasBody = !!r2Result.body;
      results.r2Test.contentType = r2Result.contentType;
      results.r2Test.error = r2Result.error;

      if (r2Result.success && r2Result.body) {
        // Try reading first few bytes
        try {
          const body = r2Result.body as any;
          if (typeof body.transformToByteArray === 'function') {
            const bytes = await body.transformToByteArray();
            results.r2Test.bytesRead = bytes.length;
            results.r2Test.streamType = 'SdkStream (transformToByteArray)';
          } else if (typeof body[Symbol.asyncIterator] === 'function') {
            let totalBytes = 0;
            for await (const chunk of body) {
              totalBytes += chunk.length;
              if (totalBytes > 1024) break; // Just read first 1KB
            }
            results.r2Test.bytesRead = totalBytes;
            results.r2Test.streamType = 'AsyncIterator';
          } else {
            results.r2Test.streamType = 'Unknown: ' + typeof body;
          }
        } catch (streamErr: any) {
          results.r2Test.streamError = streamErr.message;
        }
      }
    } catch (err: any) {
      results.r2Test.error = err.message;
    }
  }

  // 4. Quick Anthropic API test (tiny request)
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Say "ok"' }],
        }),
      });
      const text = await res.text();
      results.anthropicTest = {
        status: res.status,
        ok: res.ok,
        response: text.substring(0, 300),
      };
    } else {
      results.anthropicTest = { error: 'No ANTHROPIC_API_KEY' };
    }
  } catch (err: any) {
    results.anthropicTest = { error: err.message };
  }

  return NextResponse.json(results, { status: 200 });
}
