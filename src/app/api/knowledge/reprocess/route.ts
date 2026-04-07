import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { r2Get } from '@/lib/r2';
import { requireAdmin } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function isPdf(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.pdf');
}

function isImage(fileName: string): boolean {
  const ext = fileName.toLowerCase().split('.').pop() || '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff'].includes(ext);
}

async function extractWithVision(buffer: Buffer, fileName: string, fileType: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return '[AI vision extraction unavailable — ANTHROPIC_API_KEY not configured]';
  }

  try {
    const contentBlocks: any[] = [];

    if (isPdf(fileName)) {
      const base64 = buffer.toString('base64');
      contentBlocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 },
      });
    } else if (isImage(fileName)) {
      const mediaType = fileType.startsWith('image/') ? fileType : 'image/png';
      const base64 = buffer.toString('base64');
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: base64 },
      });
    }

    if (contentBlocks.length === 0) {
      return '[No visual content could be extracted]';
    }

    contentBlocks.push({
      type: 'text',
      text: `Extract ALL content from this document — both text AND visual elements.

TEXT: Include every heading, paragraph, list item, table, label, caption, and any other visible text. Preserve the document structure with headings and paragraphs. If there are tables, format them clearly.

VISUAL ELEMENTS: For any diagrams, line drawings, vehicle layouts, floor plans, schematics, photos, charts, or illustrations:
- Describe what the image shows (e.g. "Vehicle layout diagram: Ford Transit 148\\" wheelbase, high roof")
- Extract ALL dimensions, measurements, and annotations visible in the drawing
- Note the spatial relationships (e.g. "driver-side door 36\\" from front bumper", "rear cargo area 120\\" x 70\\"")
- Describe any color coding, labels, arrows, or callouts
- For vehicle wraps/graphics layouts, note panel names, seam lines, and graphic placement zones

Format visual descriptions in a clear section like:
[DIAGRAM: brief title]
Description and all extracted measurements/details

Output the extracted text first, then any visual element descriptions. Be thorough with measurements and spatial details — this content will be searched by an AI agent answering questions about vehicle specs, dimensions, and layouts.`,
    });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        messages: [{ role: 'user', content: contentBlocks }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Claude vision API error:', response.status, errText);
      // Include truncated error body so the caller can see the actual API error
      const shortErr = errText.length > 200 ? errText.substring(0, 200) + '...' : errText;
      return `[AI vision extraction failed: HTTP ${response.status} — ${shortErr}]`;
    }

    const result = await response.json();
    return result.content?.[0]?.text || '';
  } catch (err: any) {
    console.error('Vision extraction error:', err);
    return `[AI vision extraction failed: ${err.message}]`;
  }
}

// Stream-to-buffer helper — handles both Node.js Readable and Web ReadableStream
async function streamToBuffer(stream: any): Promise<Buffer> {
  // AWS SDK v3 on Node.js returns a Node.js Readable, not a web ReadableStream
  if (typeof stream.transformToByteArray === 'function') {
    // AWS SDK v3 SdkStream has a built-in helper
    const bytes = await stream.transformToByteArray();
    return Buffer.from(bytes);
  }
  if (typeof stream[Symbol.asyncIterator] === 'function') {
    // Node.js Readable stream
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (typeof stream.getReader === 'function') {
    // Web ReadableStream fallback
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Unknown stream type — cannot convert to buffer');
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  try {
    const { docId } = await req.json();

    if (!docId) {
      return NextResponse.json({ error: 'Missing docId' }, { status: 400 });
    }

    // Get the doc from DB
    const { data: doc, error: fetchErr } = await supabase
      .from('knowledge_docs')
      .select('*')
      .eq('id', docId)
      .single();

    if (fetchErr || !doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    if (!doc.file_path || !doc.file_name) {
      return NextResponse.json({ error: 'No file associated with this document' }, { status: 400 });
    }

    const fileName = doc.file_name;
    const fileType = doc.file_type || 'application/octet-stream';

    // Only re-process PDFs and images (vision-capable files)
    if (!isPdf(fileName) && !isImage(fileName)) {
      return NextResponse.json({ error: 'Re-processing is only available for PDFs and images' }, { status: 400 });
    }

    // Download file from R2
    const r2Result = await r2Get('knowledge-files', doc.file_path);
    if (!r2Result.success || !r2Result.body) {
      return NextResponse.json({ error: `Failed to download file from storage: ${r2Result.error || 'no body returned'} (path: ${doc.file_path})` }, { status: 500 });
    }

    let buffer: Buffer;
    try {
      buffer = await streamToBuffer(r2Result.body);
    } catch (streamErr: any) {
      console.error('Stream conversion error:', streamErr);
      return NextResponse.json({ error: 'Failed to read file stream: ' + streamErr.message }, { status: 500 });
    }

    const fileSizeMB = buffer.length / (1024 * 1024);
    console.log(`Reprocessing "${fileName}" — ${fileSizeMB.toFixed(1)} MB`);

    // Claude API has a ~25MB base64 limit; warn if file is very large
    if (fileSizeMB > 20) {
      return NextResponse.json({ error: `File too large for AI processing (${fileSizeMB.toFixed(1)} MB). Re-upload as smaller chunks.` }, { status: 400 });
    }

    // Re-extract with vision
    const extractedText = await extractWithVision(buffer, fileName, fileType);

    if (!extractedText || extractedText.startsWith('[')) {
      return NextResponse.json({ error: 'AI extraction failed: ' + extractedText }, { status: 500 });
    }

    // Truncate if needed
    const MAX_CONTENT_LENGTH = 500000;
    const finalText = extractedText.length > MAX_CONTENT_LENGTH
      ? extractedText.substring(0, MAX_CONTENT_LENGTH) + '\n\n[Content truncated — original file available for download]'
      : extractedText;

    // Update the doc
    const { error: updateErr } = await supabase
      .from('knowledge_docs')
      .update({
        content: finalText,
        updated_at: new Date().toISOString(),
      })
      .eq('id', docId);

    if (updateErr) {
      return NextResponse.json({ error: 'Failed to update document: ' + updateErr.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      extractedLength: finalText.length,
      docId,
    });
  } catch (err: any) {
    console.error('Reprocess error:', err);
    return NextResponse.json({ error: err.message || 'Reprocess failed' }, { status: 500 });
  }
}
