/**
 * CNI photo pre-screen (R6-8) — an advisory vision check at upload, while
 * the crew is still standing next to the vehicle.
 *
 * FOUR RULES THIS FILE EXISTS TO ENFORCE:
 *
 *  1. IT NEVER DENIES A PHOTO. The verdict lives in its own columns and
 *     never touches review_status. A model wrong about a legitimate
 *     night-shift photo would send a crew back out for nothing; a model
 *     that waved a bad one through would launder itself as a human
 *     approval. It advises, a reviewer decides.
 *  2. A FAILED CHECK IS `not_screened`, NEVER `pass`. No API key, a
 *     timeout, an unreadable image — all of those mean the photo was not
 *     checked, and saying "pass" would be a claim nobody made.
 *  3. WE COMPARE THE VIN, NOT THE MODEL. The prompt asks what characters
 *     are legible on the plate; the comparison against cni_job_vins.vin
 *     happens in this file. Asking a model "does this match VIN X" invites
 *     it to agree with X.
 *  4. "COULD NOT READ THE PLATE" IS NOT "WRONG VIN". An unreadable plate is
 *     a photo-quality problem; a plate that reads clearly as a DIFFERENT
 *     vehicle is a much bigger one. Collapsing them would either cry wolf
 *     on glare or hide a genuinely mixed-up VIN.
 */

export type Verdict = 'pass' | 'retake' | 'unsure' | 'not_screened';

export type FindingKey =
  | 'type_match'      // is it the angle it was filed as
  | 'sharpness'       // blurry
  | 'exposure'        // too dark / blown out
  | 'install_visible' // can the installed work be seen
  | 'vin_legible'     // can the plate be read at all
  | 'vin_match';      // does what we read agree with the row

export interface Finding {
  key: FindingKey;
  ok: boolean | null;   // null = the check could not be made
  detail: string;
}

export interface PrescreenResult {
  verdict: Verdict;
  /** One line a tired installer can act on. */
  notes: string;
  findings: Finding[];
  /** What the model reported reading off the plate, verbatim. Null when it
   *  reported nothing legible. */
  vinRead: string | null;
}

/** What the model is asked to return. Everything is optional: a reply
 *  missing a field means "could not tell", not "fine". */
export interface ModelReply {
  depicts?: string | null;
  sharp?: boolean | null;
  wellExposed?: boolean | null;
  installVisible?: boolean | null;
  vinCharacters?: string | null;
  comment?: string | null;
}

export const PHOTO_TYPES = ['front', 'back', 'driver_side', 'passenger_side', 'vin_plate', 'detail', 'other'] as const;
export type PhotoType = typeof PHOTO_TYPES[number];

const TYPE_LABEL: Record<string, string> = {
  front: 'the front of the vehicle',
  back: 'the back of the vehicle',
  driver_side: "the driver's side of the vehicle",
  passenger_side: "the passenger side of the vehicle",
  vin_plate: 'the VIN plate or sticker',
  detail: 'a close-up detail of the installed work',
  other: 'something else',
};

/**
 * The prompt. Deliberately asks for OBSERVATIONS, not judgements: what the
 * picture shows, what characters are legible. The decision about whether
 * that is good enough is made below, in code we can test and change without
 * re-tuning a model.
 */
export function buildPrompt(photoType: string): string {
  return [
    'You are checking a photograph taken by a vehicle installer on site.',
    `It was filed as: ${TYPE_LABEL[photoType] || photoType}.`,
    '',
    'Report only what you can see. Do not guess, and do not try to be helpful by',
    'filling in what you expect to be there.',
    '',
    'Reply with ONLY a JSON object, no prose, using these keys:',
    '  "depicts": short phrase for what the photo actually shows (e.g. "front of a white van")',
    '  "sharp": true if in focus, false if noticeably blurry, null if you cannot tell',
    '  "wellExposed": true if clearly lit, false if too dark or blown out, null if unsure',
    '  "installVisible": true if installed graphics/equipment are visible, false if not, null if not applicable',
    '  "vinCharacters": the characters legible on a VIN plate or sticker, EXACTLY as printed,',
    '                   or null if no plate is visible or the characters cannot be read.',
    '                   Never complete or correct a partially readable VIN.',
    '  "comment": one short sentence for the installer if something is wrong, else null',
  ].join('\n');
}

/** Lenient JSON extraction — models wrap objects in prose or fences. */
export function parseModelReply(raw: string): ModelReply | null {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed as ModelReply : null;
  } catch {
    return null;
  }
}

const normalizeVin = (v: string | null | undefined) =>
  String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** How many trailing characters must agree for a plate read to count as a
 *  match. Plates are photographed at an angle, through glass, half in
 *  shadow — a full 17-character agreement is rarely available, and the last
 *  eight are what the rest of the app already keys vehicles on. */
export const VIN_MATCH_CHARS = 8;

/**
 * Does the read agree with the expected VIN? Pure.
 *
 * Returns null when there is nothing to compare — no read, or a read too
 * short to be meaningful. That is NOT a mismatch, and treating it as one
 * would flag every glare-obscured plate as the wrong vehicle.
 */
export function vinAgrees(read: string | null | undefined, expected: string | null | undefined): boolean | null {
  const a = normalizeVin(read);
  const b = normalizeVin(expected);
  if (!a || !b) return null;
  if (a.length < VIN_MATCH_CHARS || b.length < VIN_MATCH_CHARS) {
    // Too little to be sure either way; a 4-character read agreeing by luck
    // is not evidence, and disagreeing is not proof.
    return a.length >= 4 && b.length >= 4 && b.endsWith(a) ? true : null;
  }
  return b.slice(-VIN_MATCH_CHARS) === a.slice(-VIN_MATCH_CHARS);
}

/** Which observation the declared type actually depends on. `other` and
 *  `detail` claim nothing specific, so nothing is checked against them. */
function typeMatches(photoType: string, depicts: string | null | undefined): boolean | null {
  const d = String(depicts || '').toLowerCase();
  if (!d) return null;
  if (photoType === 'other' || photoType === 'detail') return null;
  const wants: Record<string, RegExp> = {
    front: /\bfront|windshield|grille|hood\b/,
    back: /\bback|rear|tailgate|trunk|liftgate\b/,
    driver_side: /\bdriver|left side|side of\b/,
    passenger_side: /\bpassenger|right side|side of\b/,
    vin_plate: /\bvin|plate|sticker|placard|label\b/,
  };
  const re = wants[photoType];
  return re ? re.test(d) : null;
}

/**
 * Turn observations into a verdict. Pure, and the whole point of keeping
 * the model to observations: this is the part that can be argued with,
 * tested, and changed without re-tuning a prompt.
 */
export function decide(
  reply: ModelReply | null,
  ctx: { photoType: string; expectedVin: string | null },
): PrescreenResult {
  if (!reply) {
    return {
      verdict: 'not_screened',
      notes: 'The photo check did not return a usable answer, so this photo has not been checked.',
      findings: [],
      vinRead: null,
    };
  }

  const vinRead = reply.vinCharacters ? String(reply.vinCharacters).trim() || null : null;
  const agrees = ctx.photoType === 'vin_plate' ? vinAgrees(vinRead, ctx.expectedVin) : null;

  const findings: Finding[] = [
    {
      key: 'type_match',
      ok: typeMatches(ctx.photoType, reply.depicts),
      detail: reply.depicts ? `Looks like ${reply.depicts}.` : 'Could not tell what this shows.',
    },
    {
      key: 'sharpness',
      ok: reply.sharp ?? null,
      detail: reply.sharp === false ? 'Noticeably out of focus.' : reply.sharp === true ? 'In focus.' : 'Focus unclear.',
    },
    {
      key: 'exposure',
      ok: reply.wellExposed ?? null,
      detail: reply.wellExposed === false ? 'Too dark or too bright to see detail.'
        : reply.wellExposed === true ? 'Well lit.' : 'Lighting unclear.',
    },
  ];

  if (ctx.photoType !== 'vin_plate') {
    findings.push({
      key: 'install_visible',
      ok: reply.installVisible ?? null,
      detail: reply.installVisible === false ? 'The installed work is not visible in this shot.'
        : reply.installVisible === true ? 'Installed work is visible.' : 'Could not tell.',
    });
  } else {
    findings.push({
      key: 'vin_legible',
      ok: vinRead ? true : null,
      detail: vinRead ? `Read "${vinRead}" off the plate.` : 'No characters could be read off a plate.',
    });
    findings.push({
      key: 'vin_match',
      ok: agrees,
      detail: agrees === true ? 'Matches the VIN on this row.'
        : agrees === false ? `Reads as a DIFFERENT vehicle than the VIN on this row (${ctx.expectedVin || 'unknown'}).`
        : 'Not enough of the plate was readable to compare.',
    });
  }

  // A definite failure is a retake. "Could not tell" is never a retake on its
  // own — sending a crew back because the model was unsure is how the check
  // gets switched off.
  const definiteFailures = findings.filter(f => f.ok === false);
  const unknowns = findings.filter(f => f.ok === null);

  if (definiteFailures.length > 0) {
    return {
      verdict: 'retake',
      notes: reply.comment?.trim() || definiteFailures.map(f => f.detail).join(' '),
      findings, vinRead,
    };
  }
  if (unknowns.length >= 2) {
    return {
      verdict: 'unsure',
      notes: 'The check could not make out enough of this photo to say either way — worth a second look.',
      findings, vinRead,
    };
  }
  return {
    verdict: 'pass',
    notes: 'Nothing obviously wrong with this photo.',
    findings, vinRead,
  };
}

/* ── the model call ──────────────────────────────────────────────────── */

/** Anthropic's vision input caps out well below this, and a phone photo that
 *  large is a upload problem of its own. Bigger than this is not screened. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The vision model this check runs on. Named here rather than at the call
 *  site so a change is one edit, not a hunt. */
export const PRESCREEN_MODEL = 'claude-opus-5';

const SUPPORTED_MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export interface ScreenDeps {
  /** Fetch the image. Returns null when it cannot be read. */
  getImage: () => Promise<{ bytes: Buffer; contentType: string } | null>;
  /** POST to the Messages API. Injected so this is testable without a key. */
  call: (body: unknown) => Promise<Response>;
  model: string;
}

/**
 * Screen one photo. NEVER throws and NEVER returns `pass` for a check that
 * did not actually run — every failure path lands on `not_screened`, which
 * the UI shows as "not checked" rather than as approval.
 */
export async function screenPhoto(
  ctx: { photoType: string; expectedVin: string | null },
  deps: ScreenDeps,
): Promise<PrescreenResult> {
  const unscreened = (why: string): PrescreenResult =>
    ({ verdict: 'not_screened', notes: why, findings: [], vinRead: null });

  try {
    const image = await deps.getImage();
    if (!image) return unscreened('The photo could not be read back for checking.');
    if (image.bytes.byteLength > MAX_IMAGE_BYTES) {
      return unscreened('The photo is too large to check automatically.');
    }
    const mediaType = SUPPORTED_MEDIA.find(m => image.contentType.startsWith(m));
    if (!mediaType) return unscreened(`This file type (${image.contentType || 'unknown'}) cannot be checked automatically.`);

    const res = await deps.call({
      model: deps.model,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image.bytes.toString('base64') } },
          { type: 'text', text: buildPrompt(ctx.photoType) },
        ],
      }],
    });
    if (!res.ok) return unscreened(`The photo check was unavailable (${res.status}).`);

    const json: any = await res.json().catch(() => null);
    const text = (json?.content || [])
      .filter((c: any) => c?.type === 'text')
      .map((c: any) => c.text)
      .join('\n');
    const reply = parseModelReply(text || '');
    // decide() already turns a null reply into not_screened.
    return decide(reply, ctx);
  } catch (e: any) {
    return unscreened(`The photo check failed: ${String(e?.message || e).slice(0, 120)}`);
  }
}
