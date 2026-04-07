import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { r2Upload, r2Delete, r2PublicUrl } from '@/lib/r2';
import { requireAdmin } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Dynamic imports to avoid bundling issues on serverless
async function extractDocxText(buffer: Buffer): Promise<string> {
  const mammoth = (await import('mammoth')).default;
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function extractXlsxText(buffer: Buffer): Promise<string> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheets: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    if (csv.trim()) {
      sheets.push(`--- Sheet: ${sheetName} ---\n${csv}`);
    }
  }
  return sheets.join('\n\n');
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function extractCsvText(buffer: Buffer): string {
  return buffer.toString('utf-8');
}

function extractPlainText(buffer: Buffer): string {
  return buffer.toString('utf-8');
}

// Map file extensions to extraction functions
// NOTE: PDF is intentionally excluded — we use Claude vision for PDFs
// because pdfjs-dist crashes Vercel serverless functions
function getExtractor(fileName: string): ((buffer: Buffer) => Promise<string> | string) | null {
  const ext = fileName.toLowerCase().split('.').pop() || '';
  const map: Record<string, (buffer: Buffer) => Promise<string> | string> = {
    docx: extractDocxText,
    doc: extractDocxText,
    xlsx: (b) => extractXlsxText(b),
    xls: (b) => extractXlsxText(b),
    csv: extractCsvText,
    tsv: extractCsvText,
    txt: extractPlainText,
    md: extractPlainText,
    json: extractPlainText,
    xml: extractPlainText,
    html: extractPlainText,
    htm: extractPlainText,
  };
  return map[ext] || null;
}

// Image extensions
function isImage(fileName: string): boolean {
  const ext = fileName.toLowerCase().split('.').pop() || '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff'].includes(ext);
}

function isPdf(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.pdf');
}

// ─── AI Vision/Document Extraction via Claude ───
// Sends PDFs natively or images as base64 to Claude for OCR/reading
async function extractWithVision(buffer: Buffer, fileName: string, fileType: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return '[AI vision extraction unavailable — ANTHROPIC_API_KEY not configured]';
  }

  try {
    // Build the content blocks for Claude
    const contentBlocks: any[] = [];

    if (isPdf(fileName)) {
      // Claude natively supports PDF documents — send the raw bytes directly
      const base64 = buffer.toString('base64');
      contentBlocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 },
      });
    } else if (isImage(fileName)) {
      // Send the image directly as base64
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

    // Add the extraction prompt — captures both text AND visual content
    contentBlocks.push({
      type: 'text',
      text: `Extract ALL content from this document — both text AND visual elements.

TEXT: Include every heading, paragraph, list item, table, label, caption, and any other visible text. Preserve the document structure with headings and paragraphs. If there are tables, format them clearly.

VISUAL ELEMENTS: For any diagrams, line drawings, vehicle layouts, floor plans, schematics, photos, charts, or illustrations:
- Describe what the image shows (e.g. "Vehicle layout diagram: Ford Transit 148\" wheelbase, high roof")
- Extract ALL dimensions, measurements, and annotations visible in the drawing
- Note the spatial relationships (e.g. "driver-side door 36\" from front bumper", "rear cargo area 120\" x 70\"")
- Describe any color coding, labels, arrows, or callouts
- For vehicle wraps/graphics layouts, note panel names, seam lines, and graphic placement zones

Format visual descriptions in a clear section like:
[DIAGRAM: brief title]
Description and all extracted measurements/details

Output the extracted text first, then any visual element descriptions. Be thorough with measurements and spatial details — this content will be searched by an AI agent answering questions about vehicle specs, dimensions, and layouts.`,
    });

    // Send to Claude for reading
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
        messages: [{
          role: 'user',
          content: contentBlocks,
        }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Claude vision API error:', errText);
      return `[AI vision extraction failed: ${response.status}]`;
    }

    const result = await response.json();
    const text = result.content?.[0]?.text || '';
    return text;
  } catch (err: any) {
    console.error('Vision extraction error:', err);
    return `[AI vision extraction failed: ${err.message}]`;
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  try {
    const contentType = req.headers.get('content-type') || '';

    // ─── Large file path: JSON body with metadata only (file already in storage) ───
    if (contentType.includes('application/json')) {
      const body = await req.json();
      const { title, category, tags, userId, fileName, fileType, fileSize, storagePath } = body;

      const docTitle = (title || '').trim() || (fileName || 'Untitled').replace(/\.[^/.]+$/, '');
      const { data: doc, error: insertError } = await supabase
        .from('knowledge_docs')
        .insert({
          title: docTitle,
          category: category || 'other',
          content: `[Large file: ${fileName} (${(fileSize / 1024 / 1024).toFixed(1)} MB) — stored for download, too large for text extraction]`,
          tags: tags ? tags.split(',').map((t: string) => t.trim()).filter(Boolean) : null,
          file_name: fileName,
          file_type: fileType,
          file_size: fileSize,
          file_path: storagePath,
          uploaded_by: userId || null,
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (insertError) {
        return NextResponse.json({ error: 'Failed to save document: ' + insertError.message }, { status: 500 });
      }

      const fileUrl = r2PublicUrl('knowledge-files', storagePath);
      return NextResponse.json({
        success: true,
        doc,
        fileUrl,
        extractedLength: 0,
        usedVision: false,
        largeFile: true,
      });
    }

    // ─── Normal path: FormData with file ───
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const title = (formData.get('title') as string) || '';
    const category = (formData.get('category') as string) || 'other';
    const tags = (formData.get('tags') as string) || '';
    const userId = (formData.get('userId') as string) || '';

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const fileName = file.name;
    const fileType = file.type || 'application/octet-stream';
    const fileSize = file.size;

    // Read file into buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Upload original file to R2 (best-effort)
    const timestamp = Date.now();
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `uploads/${timestamp}_${safeName}`;
    let fileStored = false;

    try {
      await r2Upload('knowledge-files', storagePath, buffer, fileType);
      fileStored = true;
    } catch (storageErr: any) {
      console.error('Storage error (non-fatal):', storageErr.message);
    }

    // Extract text from the file
    let extractedText = '';
    let usedVision = false;
    const extractor = getExtractor(fileName);

    if (isPdf(fileName) || isImage(fileName)) {
      // Use Claude AI vision for PDFs and images — much more reliable than pdfjs on serverless
      try {
        extractedText = await extractWithVision(buffer, fileName, fileType);
        if (extractedText && !extractedText.startsWith('[')) {
          usedVision = true;
        } else {
          extractedText = extractedText || `[No text extracted from ${fileName}]`;
        }
      } catch (err: any) {
        console.error('AI vision extraction error:', err);
        extractedText = `[AI extraction failed for ${fileName}: ${err.message}]`;
      }
    } else if (extractor) {
      try {
        extractedText = await extractor(buffer);
      } catch (err: any) {
        console.error('Text extraction error:', err);
        extractedText = `[Text extraction failed for ${fileName}]`;
      }
    } else {
      // Try plain text as fallback
      try {
        extractedText = buffer.toString('utf-8');
        if (extractedText.includes('\0') || extractedText.includes('\ufffd')) {
          extractedText = `[Binary file: ${fileName} — content not extractable]`;
        }
      } catch {
        extractedText = `[Unsupported file format: ${fileName}]`;
      }
    }

    // Truncate if too long (Supabase text field, keep reasonable for AI context)
    const MAX_CONTENT_LENGTH = 500000; // 500k chars
    if (extractedText.length > MAX_CONTENT_LENGTH) {
      extractedText = extractedText.substring(0, MAX_CONTENT_LENGTH) + '\n\n[Content truncated — original file available for download]';
    }

    // Insert into knowledge_docs
    const docTitle = title.trim() || fileName.replace(/\.[^/.]+$/, '');

    const { data: doc, error: insertError } = await supabase
      .from('knowledge_docs')
      .insert({
        title: docTitle,
        category,
        content: extractedText || `[No text extracted from ${fileName}]`,
        tags: tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : null,
        file_name: fileName,
        file_type: fileType,
        file_size: fileSize,
        file_path: fileStored ? storagePath : null,
        uploaded_by: userId || null,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError) {
      console.error('DB insert error:', insertError);
      return NextResponse.json({ error: 'Failed to save document: ' + insertError.message }, { status: 500 });
    }

    // Get public URL for the file
    const fileUrl = fileStored ? r2PublicUrl('knowledge-files', storagePath) : null;

    return NextResponse.json({
      success: true,
      doc,
      fileUrl,
      extractedLength: extractedText.length,
      usedVision,
    });
  } catch (err: any) {
    console.error('Knowledge upload error:', err);
    return NextResponse.json({ error: err.message || 'Upload failed' }, { status: 500 });
  }
}
