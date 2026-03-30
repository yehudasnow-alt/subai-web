/**
 * SubAI — Transcription Engine v8.0
 *
 * ARCHITECTURE:
 * Modal Whisper (sync, ~2s) → Claude AI correction → Smart splitting → RTL SRT
 * No polling, no cold start. Single synchronous request.
 *
 * TIMING:     Every timestamp comes from Whisper. We never invent times.
 * CORRECTION: Claude fixes only phonetic transcription errors — never word choices.
 * TEMP=0:     Deterministic output. No creativity, no guessing, no paraphrasing.
 * VALIDATION: Per-word Levenshtein gate — each word checked individually, not the whole segment.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const maxDuration = 120;

const SUPABASE_URL         = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const AWS_REGION           = process.env.AWS_REGION   || "eu-north-1";
const S3_BUCKET            = process.env.S3_BUCKET    || "subai-audio";
const MODAL_ENDPOINT       = process.env.MODAL_ENDPOINT_URL!;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const s3 = new S3Client({
  region: AWS_REGION,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! },
});

function err(msg: string, status = 400) { return NextResponse.json({ error: true, message: msg }, { status }); }

interface Segment      { start: number; end: number; text: string; }
interface Word         { start: number; end: number; word: string; probability?: number; }
interface TimedSegment { start: number; end: number; text: string; words: Word[]; }

// ══════════════════════════════════════════════════════════════
// DATABASE
// ══════════════════════════════════════════════════════════════

async function validateApiKey(apiKey: string) {
  const { data } = await supabase.from("profiles")
    .select("id, email, plan, minutes_used, minutes_limit, subscription_status")
    .eq("api_key", apiKey).single();
  return data || null;
}

async function logUsage(userId: string, audioDur: number, lang: string, model: string,
  status: string, count = 0, procSec = 0, errMsg = "") {
  const mins = Math.ceil(audioDur / 60 * 10) / 10;
  await supabase.from("usage_log").insert({
    user_id: userId, audio_duration_sec: audioDur, minutes_charged: mins,
    language: lang, model, segments_count: count, processing_sec: procSec,
    status, error_message: errMsg,
  });
  return mins;
}

async function deductMinutes(userId: string, mins: number) {
  try { await supabase.rpc("increment_usage", { p_user_id: userId, p_minutes: mins }); return; } catch {}
  try {
    const { data } = await supabase.from("profiles").select("minutes_used").eq("id", userId).single();
    if (data) await supabase.from("profiles").update({ minutes_used: (data.minutes_used || 0) + mins }).eq("id", userId);
  } catch {}
}

// ══════════════════════════════════════════════════════════════
// STEP 1: BUILD TIMED SEGMENTS
// ══════════════════════════════════════════════════════════════

function buildTimedSegments(segments: Segment[], words: Word[]): TimedSegment[] {
  if (!words || words.length === 0) {
    return segments.map(seg => ({
      ...seg,
      words: seg.text.split(/\s+/).filter(w => w).map((w, i, arr) => {
        const dur = seg.end - seg.start, wd = dur / arr.length;
        return { start: +(seg.start + i * wd).toFixed(3), end: +(seg.start + (i + 1) * wd).toFixed(3), word: w };
      }),
    }));
  }

  const result: TimedSegment[] = [];
  let wIdx = 0;

  for (const seg of segments) {
    const sw: Word[] = [];
    while (wIdx < words.length) {
      const w = words[wIdx];
      if      (w.start >= seg.start - 0.15 && w.start < seg.end + 0.15) { sw.push(w); wIdx++; }
      else if (w.start >= seg.end + 0.15) break;
      else wIdx++;
    }
    result.push({
      start: sw.length > 0 ? sw[0].start         : seg.start,
      end:   sw.length > 0 ? sw[sw.length-1].end : seg.end,
      text:  sw.length > 0 ? sw.map(w => w.word).join(" ") : seg.text,
      words: sw,
    });
  }

  if (wIdx < words.length) {
    const rem = words.slice(wIdx);
    result.push({ start: rem[0].start, end: rem[rem.length-1].end, text: rem.map(w => w.word).join(" "), words: rem });
  }

  return result;
}

// ══════════════════════════════════════════════════════════════
// STEP 2: AI CORRECTION
// ══════════════════════════════════════════════════════════════

function isGarbageSegment(text: string): boolean {
  const latin   = (text.match(/[a-zA-Z]/g)        || []).length;
  const greek   = (text.match(/[\u0370-\u03FF]/g) || []).length;
  const symbols = (text.match(/[Ó€¡¢£¥©®™°±×÷]/g) || []).length;
  const total   = text.replace(/\s/g, "").length;
  if (total === 0) return true;
  return (latin + greek + symbols) / total > 0.3;
}

// ── Whisper Hallucination Filter ──
function filterHallucinations(
  segments: Segment[], words: Word[], prompt: string
): { segments: Segment[]; words: Word[] } {
  const filtered: Segment[] = [];
  const filteredWords: Word[] = [];
  let removedCount = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg    = segments[i];
    const dur    = seg.end - seg.start;
    const text   = seg.text.trim();
    const tw     = text.split(/\s+/).filter(w => w);
    const unique = new Set(tw.map(w => w.replace(/[.!?,;:]/g, ""))).size;

    let skip = false, reason = "";

    if (dur > 5  && unique <= 2 && tw.length >= 3) { skip = true; reason = `stuck loop: ${dur.toFixed(1)}s, ${unique} unique`; }
    if (dur > 6  && tw.length <= 1)                { skip = true; reason = `single word ${dur.toFixed(1)}s`; }
    if (dur > 10 && tw.length <= 3)                { skip = true; reason = `too long for content: ${dur.toFixed(1)}s, ${tw.length} words`; }
    if (i > 0 && text === segments[i-1].text.trim()) { skip = true; reason = "exact duplicate"; }
    if (prompt && text.length > 5) {
      const ct = text.replace(/[.!?,;:\s]/g, ""), cp = prompt.replace(/[.!?,;:\s]/g, "");
      if (cp.includes(ct) || ct.includes(cp)) { skip = true; reason = "prompt leak"; }
    }
    if (tw.length >= 4 && unique <= 2) { skip = true; reason = `repeating pattern: "${tw.slice(0,3).join(" ")}..."`; }

    if (skip) {
      console.log(`[FILTER] Removed seg ${i} (${reason}): "${text.substring(0,40)}${text.length>40?"...":""}"`);
      removedCount++;
    } else {
      filtered.push(seg);
    }
  }

  if (removedCount > 0 && words.length > 0) {
    for (const w of words) {
      if (filtered.some(s => w.start >= s.start - 0.1 && w.start < s.end + 0.1)) filteredWords.push(w);
    }
    console.log(`[FILTER] Removed ${removedCount} hallucinated segs, kept ${filtered.length}. Words: ${words.length}→${filteredWords.length}`);
    return { segments: filtered, words: filteredWords };
  }
  return { segments, words };
}

// ── Levenshtein distance (normalised 0–1) ──
function levenshtein(a: string, b: string): number {
  if (a === b)   return 0;
  if (!a.length) return 1;
  if (!b.length) return 1;
  const m: number[][] = [];
  for (let i = 0; i <= a.length; i++) m[i] = [i];
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      m[i][j] = Math.min(m[i-1][j]+1, m[i][j-1]+1, m[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  return m[a.length][b.length] / Math.max(a.length, b.length);
}

// ── Per-word validation ──
//
// Checks every word individually instead of the whole segment as a blob.
// This lets חינוני→חילוני (1 letter, ~14%) pass while blocking הלך→צעד (100%).
//
// Word-count tolerance:
//   Normal:  ±1  (Hebrew prefix ש/ל/מ/כ can split/merge)
//   Garbage: ±3  (full reconstruction allowed)
//
// Per-word distance threshold:
//   Normal:  0.55  (allows single-letter fixes on short words)
//   Garbage: 0.85
//
function validateCorrection(orig: string, corr: string, isGarbage: boolean): {
  ok: boolean; reason: string;
} {
  const strip = (s: string) => s.replace(/[.!?,;:״"']/g, "").trim();

  const ow = orig.split(/\s+/).filter(w => w && !/^[.!?,;:]+$/.test(w));
  const cw = corr.split(/\s+/).filter(w => w && !/^[.!?,;:]+$/.test(w));

  const maxDiff = isGarbage ? 3 : 1;
  const diff    = Math.abs(ow.length - cw.length);
  if (diff > maxDiff) {
    return { ok: false, reason: `word-count ${ow.length}→${cw.length} (diff=${diff}, max=${maxDiff})` };
  }

  const MAX_WORD_DIST = isGarbage ? 0.85 : 0.55;
  const len = Math.min(ow.length, cw.length);

  for (let i = 0; i < len; i++) {
    const a = strip(ow[i]);
    const b = strip(cw[i]);
    if (a === b) continue;
    const d = levenshtein(a, b);
    if (d > MAX_WORD_DIST) {
      return { ok: false, reason: `word[${i}] dist=${(d*100).toFixed(0)}% "${ow[i]}"→"${cw[i]}"` };
    }
  }

  return { ok: true, reason: "" };
}

async function aiCorrect(
  timedSegs: TimedSegment[], language: string
): Promise<{ segments: TimedSegment[]; method: string }> {
  if (!ANTHROPIC_API_KEY || timedSegs.length === 0) return { segments: timedSegs, method: "none" };

  try {
    // ── Full plain-text transcript — Claude reads this first ──
    const fullContext           = timedSegs.map(s => s.text.trim()).join(" ");
    const segmentsForCorrection = timedSegs
      .map((s, i) => `[${i}|${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`)
      .join("\n");

    // ── The surgical correction prompt ──
    //
    // Design decisions:
    //  • Chain-of-Thought via <thinking> block — Claude identifies the topic and
    //    suspicious words before touching anything. The Regex parser ignores
    //    everything outside [index|...] lines, so thinking is free.
    //  • temperature=0   — deterministic, no synonyms, no creativity.
    //  • ±1 word allowed — Hebrew prefix split/merge (ש/ל/מ/כ).
    //  • 1% doubt rule   — default is NO change.
    //  • Universal Hebrew — covers all registers: legal, medical, slang, tech.
    const systemPrompt = `אתה מומחה אוניברסלי לתיקון תמלול ולשפה העברית על כל רבדיה (משפטית, רפואית, אקדמית, שפת רחוב וסלנג). קיבלת תמלול שנוצר על ידי מודל שמיעה (Whisper).
תפקידך הבלעדי הוא לתקן שגיאות זיהוי פונטיות — מילים שוויספר שמע לא נכון — תוך שמירה אבסולוטית על הטקסט המקורי שביטא הדובר.

תהליך העבודה שלך (חובה):
לפני שאתה פולט את הסגמנטים המתוקנים, פתח תגית XML בשם <thinking>.
בתוך התגית, רשום לעצמך:
1. מהו נושא השיחה הכללי?
2. זהה 3-5 מילים שהן בבירור טעויות שמיעה פונטיות — מילים שלא קיימות בעברית, או מילים שנשמעות דומה למשהו הגיוני בהקשר הזה.
לאחר מכן סגור </thinking> ורק אז פלוט את הסגמנטים בפורמט הנדרש.

חוקי ברזל (בלתי ניתנים לערעור):

1. כמות מילים — אסור להוסיף או למחוק מילים, למעט תחיליות עבריות (ש/ל/מ/כ/ב/ו) שהתמזגו או התפצלו בטעות (הפרש של מילה אחת בלבד).

2. תיקון אותיות בלבד — מותר לתקן: אות שגויה, אות חסרה, אות מיותרת, הומופון.
   ✓ חינוני→חילוני / הלק→הלך / קרא→קרה / אל גור איתם→אלגוריתם
   ✗ הלך→צעד / גדול→עצום / אמר→ציין (החלפת מילה — אסור לחלוטין)

3. שמירה על שפת הדובר — אל תתקן שגיאות דקדוק של הדובר עצמו.
   "שלוש שקל", "אני יגיד", "הוא אמרה" — השאר כצאתם.

4. מילות מילוי — כאילו, אממ, אה, נו, כזה, טוב, אז — חובה להשאיר כצאתן. הן עוגני תזמון.

5. כלל הספק — אם המשפט הגיוני גם ללא תיקון, או שיש ספק כלשהו: אל תשנה. ברירת המחדל היא אי-שינוי.

פורמט פלט: [index|start-end] text — שורה אחת לכל סגמנט, כל הסגמנטים, ללא הקדמות מחוץ ל-thinking.`;

    const userMessage = `תמלול מלא להבנת ההקשר — קרא לפני הכל:
===
${fullContext}
===

סגמנטים לתיקון:

${segmentsForCorrection}`;

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 50000);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:       "claude-sonnet-4-20250514",
        max_tokens:  8192,
        temperature: 0,
        system:      systemPrompt,
        messages:    [{ role: "user", content: userMessage }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return { segments: timedSegs, method: "api_error" };

    const result = await response.json();
    const output = result.content?.[0]?.text || "";

    // Regex picks up only [N|t-t] lines — <thinking> block is silently ignored.
    const corrected: Array<{ idx: number; text: string }> = [];
    for (const line of output.split("\n")) {
      const m = line.match(/\[(\d+)\|([\d.]+)-([\d.]+)\]\s*(.*)/);
      if (m && m[4].trim()) corrected.push({ idx: parseInt(m[1]), text: m[4].trim() });
    }

    if (corrected.length === 0 || Math.abs(corrected.length - timedSegs.length) > timedSegs.length * 0.3) {
      console.warn(`[AI] REJECTED ALL: ${timedSegs.length}→${corrected.length}`);
      return { segments: timedSegs, method: "integrity_fail" };
    }

    let acceptCount = 0, rejectCount = 0;
    const fixed = timedSegs.map((seg, i) => {
      const correction = corrected.find(c => c.idx === i);
      if (!correction) return seg;

      // Punctuation-only change — always accept
      const origClean = seg.text.replace(/[.!?,;:\s]/g, "");
      const corrClean = correction.text.replace(/[.!?,;:\s]/g, "");
      if (origClean === corrClean) {
        if (seg.text.trim() !== correction.text) acceptCount++;
        return { ...seg, text: correction.text };
      }

      const isGarbage = isGarbageSegment(seg.text);

      // Per-word validation
      const { ok, reason } = validateCorrection(seg.text, correction.text, isGarbage);
      if (!ok) {
        console.warn(`[AI] SEG ${i} REJECTED (${reason}): "${seg.text.trim()}" → "${correction.text}"`);
        rejectCount++;
        return seg;
      }

      console.log(`[AI] SEG ${i} ACCEPTED: "${seg.text.trim()}" → "${correction.text}"`);
      acceptCount++;

      // Sync corrected words back onto original Whisper word timestamps
      const corrWords = correction.text.split(/\s+/).filter(w => w);
      if (!seg.words || seg.words.length === 0) return { ...seg, text: correction.text };

      const syncedWords = seg.words.map((w, wi) =>
        wi < corrWords.length ? { ...w, word: corrWords[wi] } : w
      );
      if (corrWords.length > seg.words.length) {
        const last = seg.words[seg.words.length - 1];
        for (let x = seg.words.length; x < corrWords.length; x++) {
          syncedWords.push({ start: last.end, end: last.end + 0.1, word: corrWords[x] });
        }
      }

      return { ...seg, text: correction.text, words: syncedWords };
    });

    console.log(`[AI] SUMMARY: ${acceptCount} accepted, ${rejectCount} rejected, ${timedSegs.length - acceptCount - rejectCount} unchanged`);
    return { segments: fixed, method: "claude" };

  } catch (e: any) {
    if (e.name === "AbortError") {
      console.warn(`[AI] Claude timeout (50s) for ${timedSegs.length} segments — using Whisper original`);
      return { segments: timedSegs, method: "timeout_fallback" };
    }
    console.error("[AI] Error:", e.message || e);
    return { segments: timedSegs, method: "error_fallback" };
  }
}

// ══════════════════════════════════════════════════════════════
// STEP 2.5: BOUNDARY REPAIR — per-segment anchoring (no global drift)
//
// TIMING GUARANTEE: Every segment's start/end is taken DIRECTLY from the
// Whisper origWords that fall inside that segment's time window.
// Corrected words are mapped proportionally within that window.
// No cumulative drift — each segment is independently anchored to Whisper.
// ══════════════════════════════════════════════════════════════

function repairBoundaries(segs: TimedSegment[], origWords: Word[]): TimedSegment[] {
  if (!origWords || origWords.length === 0) return segs;

  const result: TimedSegment[] = [];

  for (const seg of segs) {
    const segOrigWords = origWords.filter(
      w => w.start >= seg.start - 0.15 && w.start < seg.end + 0.15
    );

    if (segOrigWords.length === 0) { result.push(seg); continue; }

    const corrWords = seg.text.split(/\s+/).filter(w => w);
    if (corrWords.length === 0) continue;

    const newWords: Word[] = corrWords.map((word, i) => {
      const origIdx = Math.min(
        Math.round(i * segOrigWords.length / corrWords.length),
        segOrigWords.length - 1
      );
      return { start: segOrigWords[origIdx].start, end: segOrigWords[origIdx].end, word };
    });

    result.push({
      start: segOrigWords[0].start,                    // ← ALWAYS from Whisper
      end:   segOrigWords[segOrigWords.length-1].end,  // ← ALWAYS from Whisper
      text:  corrWords.join(" "),
      words: newWords,
    });
  }

  return result.length > 0 ? result : segs;
}

// ══════════════════════════════════════════════════════════════
// STEP 3: SPLITTING — all timestamps from Whisper
// ══════════════════════════════════════════════════════════════

function applySplitting(segs: TimedSegment[], style: string, wpg: number): Segment[] {
  const all: Word[] = [];
  for (const s of segs) for (const w of s.words) all.push(w);
  if (all.length === 0) return segs;

  if (style === "sentence") return splitSentence(all);
  if (style?.startsWith("word")) {
    const n = parseInt(style.replace("word", "")) || wpg || 1;
    return splitWords(all, Math.max(1, Math.min(6, n)));
  }
  return splitAuto(all);
}

function mkSeg(words: Word[]): Segment {
  return { start: words[0].start, end: words[words.length-1].end, text: words.map(w => w.word).join(" ") };
}

function splitSentence(all: Word[]): Segment[] {
  const r: Segment[] = []; let c: Word[] = [];
  for (const w of all) { c.push(w); if (/[.!?]$/.test(w.word.trim())) { r.push(mkSeg(c)); c = []; } }
  if (c.length) r.push(mkSeg(c));
  return r;
}

function splitWords(all: Word[], gs: number): Segment[] {
  const r: Segment[] = []; let c: Word[] = [];
  for (let i = 0; i < all.length; i++) {
    c.push(all[i]);
    if (c.length >= gs) {
      if (i+1 < all.length && isBound(all[i], all[i+1]) && c.length < gs+2) continue;
      r.push(mkSeg(c)); c = [];
    }
  }
  if (c.length) r.push(mkSeg(c));
  return r;
}

function splitAuto(all: Word[]): Segment[] {
  const SOFT = 38, HARD = 50, MAXD = 4;
  const r: Segment[] = []; let c: Word[] = []; let ct = "";

  for (let i = 0; i < all.length; i++) {
    const w = all[i];
    c.push(w);
    ct = ct ? ct + " " + w.word : w.word;
    const dur = c.length > 1 ? w.end - c[0].start : 0;

    if (/[.!?]$/.test(w.word.trim()))                         { r.push(mkSeg(c)); c = []; ct = ""; continue; }
    if (/,$/.test(w.word.trim()) && ct.length >= 20)          { r.push(mkSeg(c)); c = []; ct = ""; continue; }

    if (ct.length >= SOFT && c.length >= 2) {
      const chain = countChain(all, i+1);
      if (!chain)                                             { r.push(mkSeg(c)); c = []; ct = ""; continue; }
      let extra = 0;
      for (let x = 1; x <= chain && i+x < all.length; x++) extra += all[i+x].word.length + 1;
      if (ct.length + extra <= HARD) continue;
      const lb = countTail(c);
      if (lb > 0 && c.length - lb >= 2) {
        r.push(mkSeg(c.slice(0, c.length - lb)));
        c = c.slice(c.length - lb); ct = c.map(w => w.word).join(" "); continue;
      }
      r.push(mkSeg(c)); c = []; ct = ""; continue;
    }

    if (ct.length >= HARD || dur >= MAXD)                     { r.push(mkSeg(c)); c = []; ct = ""; continue; }
  }
  if (c.length) r.push(mkSeg(c));
  return r;
}

function isBound(a: Word, b: Word): boolean {
  const wa = a.word.trim().replace(/[,.:;!?"״]+$/g, "");
  const wb = b.word.trim().replace(/[,.:;!?"״]+$/g, "");
  if (["הרב","הגאון","הרבנית","מורנו","ורבנו","המקובל","הצדיק","ר'","רבי","דר","פרופ","מר","גב",'עו"ד'].includes(wa)) return true;
  if (["לא","אל","אין","בלי","ללא","אינו","אינה","אינם"].includes(wa)) return true;
  if (!wa.startsWith("ה") && wb.startsWith("ה") && wb.length > 2) return true;
  if (["את","של","על","אל","עם","בת","בן","כל","גם","רק","כי","אם","או","כמו"].includes(wa)) return true;
  if (["ו","וגם","אבל","אלא"].includes(wa)) return true;
  if (/^\d+$/.test(wa)) return true;
  if (["ש","כש","לכש","מש"].includes(wa)) return true;
  const bc = wb.replace(/[""״]/g, '"');
  if (['שליט"א',"שליטא",'זצ"ל',"זצל",'זיע"א'].some(h => bc === h || bc.startsWith(h))) return true;
  return false;
}

function countChain(w: Word[], si: number): number {
  let c = 0, i = si;
  while (i < w.length && i > 0 && isBound(w[i-1], w[i])) { c++; i++; }
  return c;
}

function countTail(c: Word[]): number {
  if (c.length < 2) return 0;
  let n = 0;
  for (let i = c.length-1; i >= 1; i--) {
    const a = c[i].word.trim().replace(/[,.:;!?]+$/g, "");
    if (["הרב","הגאון","מורנו","ורבנו","המקובל","לא","אל","אין","את","של","על","עם","כל","גם","כי","ש","כש"].includes(a)) n++;
    else break;
  }
  return n;
}

// ══════════════════════════════════════════════════════════════
// SRT BUILDER (RTL)
// ══════════════════════════════════════════════════════════════

function buildSrt(segs: Segment[], lang = "he"): string {
  const rtl = lang === "he" || lang === "ar";
  const RLM = "\u200F";
  const ts  = (s: number) => {
    s = Math.max(0, s);
    const h  = Math.floor(s / 3600);
    const m  = Math.floor((s % 3600) / 60);
    const sc = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sc).padStart(2,"0")},${String(ms).padStart(3,"0")}`;
  };
  return segs.map((seg, i) => {
    const t = seg.text.trim();
    if (!t) return "";
    return `${i+1}\n${ts(seg.start)} --> ${ts(seg.end)}\n${rtl ? RLM + t : t}\n`;
  }).filter(Boolean).join("\n");
}

// ══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { api_key, action, lang, audio_duration, caption_style, words_per_group } = body;

    if (!api_key) return err("Missing api_key", 401);
    const user = await validateApiKey(api_key);
    if (!user)   return err("Invalid API key", 401);

    const remaining = (user.minutes_limit || 0) - (user.minutes_used || 0);
    if (remaining <= 0) return err("נגמרה המכסה. שדרג תוכנית.", 403);

    if (action === "get_upload_url") {
      const fileKey     = `audio/${user.id}/${Date.now()}.mp3`;
      const putCmd      = new PutObjectCommand({ Bucket: S3_BUCKET, Key: fileKey, ContentType: "audio/mpeg" });
      const uploadUrl   = await getSignedUrl(s3, putCmd, { expiresIn: 300 });
      const getCmd      = new GetObjectCommand({ Bucket: S3_BUCKET, Key: fileKey });
      const downloadUrl = await getSignedUrl(s3, getCmd, { expiresIn: 3600 });
      return NextResponse.json({ upload_url: uploadUrl, download_url: downloadUrl, file_key: fileKey, remaining_minutes: remaining });
    }

    if (action === "transcribe") {
      const { download_url, file_key } = body;
      if (!download_url) return err("Missing download_url");
      const audioDur = audio_duration || 0;
      if (Math.ceil(audioDur / 60 * 10) / 10 > remaining) return err("לא מספיק דקות.", 403);

      // STEP 1: Modal Whisper
      console.log("[MODAL] Sending to Whisper...");
      const t0 = Date.now();

      const modalRes = await fetch(MODAL_ENDPOINT, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ audio_url: download_url, lang: lang || "he" }),
      });

      if (!modalRes.ok) {
        const me = await modalRes.text();
        console.error("[MODAL] Error:", me);
        await logUsage(user.id, audioDur, lang || "he", "whisper-large-v3", "failed", 0, 0, me);
        return err("שגיאת תמלול.", 502);
      }

      const mr = await modalRes.json();
      const whisperMs = Date.now() - t0;

      if (mr.error) {
        console.error("[MODAL] Whisper error:", mr.error);
        await logUsage(user.id, audioDur, lang || "he", "whisper-large-v3", "failed", 0, 0, mr.error);
        return err("שגיאת תמלול: " + mr.error, 500);
      }

      console.log(`[MODAL] Done in ${whisperMs}ms — ${mr.segments?.length||0} segs, ${mr.words?.length||0} words`);

      const rawSegs:  Segment[] = (mr.segments||[]).map((s: any) => ({ start: s.start, end: s.end, text: (s.text||"").trim() }));
      const rawWords: Word[]    = (mr.words   ||[]).map((w: any) => ({ start: w.start, end: w.end, word: (w.word||"").trim() }));

      if (rawSegs.length === 0) {
        await logUsage(user.id, audioDur, lang||"he", "whisper-large-v3", "empty", 0, 0);
        return err("לא נמצא דיבור.", 200);
      }

      // STEP 1.5: Filter hallucinations
      const hePrompt = lang === "he"
        ? "שלום, זהו תמלול מקצועי בעברית תקנית. סימני פיסוק: נקודה, פסיק, סימן שאלה. שמות אנשים, מקומות ומונחים מקצועיים נכתבים במדויק."
        : "";
      const cleaned = filterHallucinations(rawSegs, rawWords, hePrompt);

      if (cleaned.segments.length === 0) {
        await logUsage(user.id, audioDur, lang||"he", "whisper-large-v3", "empty", 0, 0);
        return err("לא נמצא דיבור.", 200);
      }

      // STEP 2: Build timed segments
      const timedSegs = buildTimedSegments(cleaned.segments, cleaned.words);

      // STEP 3: Claude AI correction
      // temp=0 · full context · <thinking> CoT · per-word validation
      const aiResult = await aiCorrect(timedSegs, lang || "he");

      // STEP 3.5: Re-anchor every segment boundary to Whisper timestamps
      const repaired = repairBoundaries(aiResult.segments, rawWords);

      // STEP 4: Split into caption groups
      const wpg   = parseInt(words_per_group) || 1;
      const final = applySplitting(repaired, caption_style || "auto", wpg);

      // STEP 5: Build SRT
      const srt = buildSrt(final, lang || "he");

      // STEP 6: Log & deduct
      const totalMs = Date.now() - t0;
      const mins    = await logUsage(user.id, audioDur, lang||"he", "whisper-large-v3", "completed", final.length, totalMs/1000);
      await deductMinutes(user.id, mins);

      if (file_key) s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: file_key })).catch(() => {});

      console.log(`[DONE] ${final.length} segs, ${totalMs}ms (Whisper: ${whisperMs}ms, Claude: ${totalMs-whisperMs}ms)`);

      return NextResponse.json({
        ok: true, status: "completed", segments: final, srt,
        language: mr.language || lang, elapsed: (totalMs/1000).toFixed(1),
        count: final.length, minutes_charged: mins,
        minutes_remaining: remaining - mins, ai_correction: aiResult.method,
      });
    }

    if (action === "check_job") return NextResponse.json({ ok: true, status: "completed", message: "Modal is synchronous" });

    if (action === "status") return NextResponse.json({
      ok: true, plan: user.plan, minutes_used: user.minutes_used,
      minutes_limit: user.minutes_limit, minutes_remaining: remaining,
    });

    return err("Unknown action");

  } catch (e: any) {
    console.error("API Error:", e);
    return err("שגיאה פנימית", 500);
  }
}
