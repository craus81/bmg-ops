import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Dynamic imports to avoid bundling issues on serverless
async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(buffer);
    const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;

    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((item: any) => item.str)
        .join(' ');
      if (text.trim()) pages.push(text.trim());
    }
    return pages.join('\n\n');
  } catch (err: any) {
    console.error('PDF extraction error:', err);
    return `[PDF text extraction failed: ${err.message}]`;
  }
}

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
function getExtractor(fileName: string): ((buffer: Buffer) => Promise<string> | string) | null {
  const ext = fileName.toLowerCase().split('.').pop() || '';
  const map: Record<string, (buffer: Buffer) => Promise<string> | string> = {
    pdf: extractPdfText,
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

// Image extensions (store only, no text extraction)
function isImage(fileName: string): boolean {
  const ext = fileName.toLowerCase().split('.').pop() || '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff'].includes(ext);
}

export async function POST(req: NextRequest) {
  try {
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

    // Upload original file to Supabase Storage
    const timestamp = Date.now();
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `uploads/${timestamp}_${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from('knowledge-files')
      .upload(storagePath, buffer, {
        contentType: fileType,
        upsert: false,
      });

    if (uploadError) {
      console.error('Storage upload error:', uploadError);
      return NextResponse.json({ error: 'Failed to upload file: ' + uploadError.message }, { status: 500 });
    }

    // Extract text from the file
    let extractedText = '';
    const extractor = getExtractor(fileName);

    if (extractor) {
      try {
        extractedText = await extractor(buffer);
      } catch (err: any) {
        console.error('Text extraction error:', err);
        extractedText = `[Text extraction failed for ${fileName}: ${err.message}]`;
      }
    } else if (isImage(fileName)) {
      extractedText = `[Image file: ${fileName}]`;
    } else {
      // Try plain text as fallback
      try {
        extractedText = buffer.toString('utf-8');
        // If it looks like binary garbage, mark it
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
        file_path: storagePath,
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
    const { data: urlData } = supabase.storage
      .from('knowledge-files')
      .getPublicUrl(storagePath);

    return NextResponse.json({
      success: true,
      doc,
      fileUrl: urlData?.publicUrl || null,
      extractedLength: extractedText.length,
    });
  } catch (err: any) {
    console.error('Knowledge upload error:', err);
    return NextResponse.json({ error: err.message || 'Upload failed' }, { status: 500 });
  }
}
