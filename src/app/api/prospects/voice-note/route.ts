import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const maxDuration = 30;

const Schema = z.object({
  prospectId: z.string().uuid(),
  noteText: z.string().trim().min(1).max(20_000),
  userId: z.string().uuid().optional().nullable(),
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const PARSE_PROMPT = `You are parsing a salesperson's voice note about a prospect/customer meeting. Extract:

1. A clean summary of what happened (1-3 sentences)
2. Any follow-up actions with dates

For dates, interpret relative phrases based on today's date which is PROVIDED.
- "next week" = 7 days from today
- "in a week" = 7 days from today
- "by Friday" = the coming Friday
- "tomorrow" = tomorrow
- "in a few days" = 3 days from today
- "end of month" = last day of current month
- "next month" = 1st of next month

Return JSON only:
{
  "summary": "Clean summary of the note",
  "actions": [
    {
      "title": "Short action title (e.g. 'Send proposal to John')",
      "description": "More detail if any",
      "due_date": "2025-01-15T09:00:00"
    }
  ]
}

If no specific follow-up actions or dates are mentioned, return an empty actions array.
Always return valid JSON, nothing else.`;

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'AI not configured' }, { status: 500 });
  }

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { prospectId, noteText, userId } = parsed.data;

  try {

    const today = new Date().toISOString().split('T')[0];
    const dayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'long' });

    // Parse with Claude
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Today is ${dayOfWeek}, ${today}.\n\nVoice note transcript:\n"${noteText.trim()}"\n\n${PARSE_PROMPT}`,
        }],
      }),
    });

    if (!aiRes.ok) {
      console.error('AI parse failed:', aiRes.status, await aiRes.text());
      // Fall back to saving raw note without AI parsing
      const { data: activity } = await supabase.from('prospect_activities').insert({
        prospect_id: prospectId,
        type: 'note',
        summary: noteText.trim(),
        created_by: userId,
      }).select('id').single();

      return NextResponse.json({ summary: noteText.trim(), actions: [], activityId: activity?.id });
    }

    const aiResult = await aiRes.json();
    const aiText = aiResult.content?.[0]?.text || '';

    let parsed: { summary: string; actions: { title: string; description?: string; due_date: string }[] };
    try {
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { summary: noteText.trim(), actions: [] };
    } catch {
      parsed = { summary: noteText.trim(), actions: [] };
    }

    // Save the activity
    const { data: activity } = await supabase.from('prospect_activities').insert({
      prospect_id: prospectId,
      type: 'note',
      summary: parsed.summary,
      details: noteText.trim() !== parsed.summary ? noteText.trim() : null,
      created_by: userId,
    }).select('id').single();

    // Create reminders for each action
    const reminders: any[] = [];
    for (const action of parsed.actions) {
      if (!action.title || !action.due_date) continue;
      const { data: reminder } = await supabase.from('prospect_reminders').insert({
        prospect_id: prospectId,
        activity_id: activity?.id,
        title: action.title,
        description: action.description || null,
        due_at: action.due_date,
        created_by: userId,
      }).select().single();
      if (reminder) reminders.push(reminder);
    }

    return NextResponse.json({
      summary: parsed.summary,
      actions: parsed.actions,
      activityId: activity?.id,
      reminders: reminders.length,
    });
  } catch (err: any) {
    console.error('Voice note error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
