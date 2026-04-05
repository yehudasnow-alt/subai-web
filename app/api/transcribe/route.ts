/**
 * SubAI — Transcription Engine v9.1 (Haiku — Hebrew Language Expert)
 *
 * ARCHITECTURE:
 * Modal Whisper → Hallucination Filter → Haiku Hebrew Expert (2-pass) → Split → RTL SRT
 *
 * ════════════════════════════════════════════════════════════
 * IRON LAW: ALL TIMESTAMPS ARE WHISPER'S ORIGINALS.
 * AI corrects TEXT ONLY. Word count per segment stays IDENTICAL.
 * word.start / word.end are NEVER modified.
 * ════════════════════════════════════════════════════════════
 *
 * PHILOSOPHY:
 * Haiku doesn't pattern-match — it READS the full text, UNDERSTANDS
 * the topic and context, THINKS about what was actually said, and
 * DECODES Whisper's phonetic errors using deep Hebrew knowledge.
 * It covers ALL registers: biblical, talmudic, legal, medical,
 * tech, academic, military, news, colloquial, children's, poetry,
 * and everything in between.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const maxDuration = 120;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const AWS_REGION = process.env.AWS_REGION || "eu-north-1";
const S3_BUCKET = process.env.S3_BUCKET || "subai-audio";
const MODAL_ENDPOINT = process.env.MODAL_ENDPOINT_URL!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

function err(msg: string, status = 400) {
  return NextResponse.json({ error: true, message: msg }, { status });
}

interface Segment { start: number; end: number; text: string; }
interface Word { start: number; end: number; word: string; probability?: number; }
interface TimedSegment { start: number; end: number; text: string; words: Word[]; }

// ══════════════════════════════════════════════════════════════
// DATABASE
// ══════════════════════════════════════════════════════════════

async function validateApiKey(apiKey: string) {
  const { data } = await supabase
    .from("profiles")
    .select("id, email, plan, minutes_used, minutes_limit, subscription_status")
    .eq("api_key", apiKey)
    .single();
  return data || null;
}

async function logUsage(
  userId: string, audioDur: number, lang: string, model: string,
  status: string, count = 0, procSec = 0, errMsg = "",
) {
  const mins = Math.ceil((audioDur / 60) * 10) / 10;
  await supabase.from("usage_log").insert({
    user_id: userId, audio_duration_sec: audioDur, minutes_charged: mins,
    language: lang, model, segments_count: count, processing_sec: procSec,
    status, error_message: errMsg,
  });
  return mins;
}

async function deductMinutes(userId: string, mins: number) {
  try {
    await supabase.rpc("increment_usage", { p_user_id: userId, p_minutes: mins });
    return;
  } catch {}
  try {
    const { data } = await supabase.from("profiles").select("minutes_used").eq("id", userId).single();
    if (data) {
      await supabase.from("profiles").update({ minutes_used: (data.minutes_used || 0) + mins }).eq("id", userId);
    }
  } catch {}
}

// ══════════════════════════════════════════════════════════════
// STEP 1: BUILD TIMED SEGMENTS
// ══════════════════════════════════════════════════════════════

function buildTimedSegments(segments: Segment[], words: Word[]): TimedSegment[] {
  if (!words || words.length === 0) {
    return segments.map((seg) => ({
      ...seg,
      words: seg.text.split(/\s+/).filter((w) => w).map((w, i, arr) => {
        const dur = seg.end - seg.start;
        const wd = dur / arr.length;
        return {
          start: +(seg.start + i * wd).toFixed(3),
          end: +(seg.start + (i + 1) * wd).toFixed(3),
          word: w,
        };
      }),
    }));
  }

  const result: TimedSegment[] = [];
  let wIdx = 0;

  for (const seg of segments) {
    const sw: Word[] = [];
    while (wIdx < words.length) {
      const w = words[wIdx];
      if (w.start >= seg.start - 0.15 && w.start < seg.end + 0.15) {
        sw.push(w);
        wIdx++;
      } else if (w.start >= seg.end + 0.15) {
        break;
      } else {
        wIdx++;
      }
    }
    result.push({
      start: sw.length > 0 ? sw[0].start : seg.start,
      end: sw.length > 0 ? sw[sw.length - 1].end : seg.end,
      text: sw.length > 0 ? sw.map((w) => w.word).join(" ") : seg.text,
      words: sw,
    });
  }

  if (wIdx < words.length) {
    const rem = words.slice(wIdx);
    result.push({
      start: rem[0].start, end: rem[rem.length - 1].end,
      text: rem.map((w) => w.word).join(" "), words: rem,
    });
  }
  return result;
}

// ══════════════════════════════════════════════════════════════
// STEP 1.5: HALLUCINATION FILTER
// ══════════════════════════════════════════════════════════════

function isGarbageSegment(text: string): boolean {
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  const greek = (text.match(/[\u0370-\u03FF]/g) || []).length;
  const symbols = (text.match(/[Ó€¡¢£¥©®™°±×÷]/g) || []).length;
  const total = text.replace(/\s/g, "").length;
  if (total === 0) return true;
  return (latin + greek + symbols) / total > 0.3;
}

function filterHallucinations(
  segments: Segment[], words: Word[], prompt: string,
): { segments: Segment[]; words: Word[] } {
  const filtered: Segment[] = [];
  const filteredWords: Word[] = [];
  let removedCount = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const dur = seg.end - seg.start;
    const text = seg.text.trim();
    const textWords = text.split(/\s+/).filter((w) => w);
    const uniqueWords = new Set(textWords.map((w) => w.replace(/[.!?,;:]/g, ""))).size;

    let skip = false;
    let reason = "";

    if (dur > 5 && uniqueWords <= 2 && textWords.length >= 3) {
      skip = true; reason = "stuck loop";
    }
    if (dur > 6 && textWords.length <= 1) {
      skip = true; reason = `single word ${dur.toFixed(1)}s`;
    }
    if (dur > 10 && textWords.length <= 3) {
      skip = true; reason = "too long for content";
    }
    if (i > 0 && text === segments[i - 1].text.trim()) {
      skip = true; reason = "exact duplicate";
    }
    if (prompt && text.length > 5) {
      const ct = text.replace(/[.!?,;:\s]/g, "");
      const cp = prompt.replace(/[.!?,;:\s]/g, "");
      if (cp.includes(ct) || ct.includes(cp)) {
        skip = true; reason = "prompt leak";
      }
    }
    if (textWords.length >= 4 && uniqueWords <= 2) {
      skip = true; reason = "repeating pattern";
    }

    if (skip) {
      console.log(`[FILTER] Removed seg ${i} (${reason}): "${text.substring(0, 40)}…"`);
      removedCount++;
    } else {
      filtered.push(seg);
    }
  }

  if (removedCount > 0 && words.length > 0) {
    for (const w of words) {
      if (filtered.some((s) => w.start >= s.start - 0.1 && w.start < s.end + 0.1)) {
        filteredWords.push(w);
      }
    }
    console.log(`[FILTER] Removed ${removedCount}, kept ${filtered.length}. Words: ${words.length}→${filteredWords.length}`);
    return { segments: filtered, words: filteredWords };
  }
  return { segments, words };
}

// ══════════════════════════════════════════════════════════════
// STEP 2A: CONFIDENCE HINTS — Tell Haiku where Whisper struggled
// ══════════════════════════════════════════════════════════════

function buildConfidenceHints(timedSegs: TimedSegment[]): string {
  const hints: string[] = [];
  for (let si = 0; si < timedSegs.length; si++) {
    const seg = timedSegs[si];
    const low: string[] = [];
    for (const w of seg.words) {
      if (w.probability !== undefined && w.probability < 0.7) {
        low.push(`"${w.word}"(${(w.probability * 100).toFixed(0)}%)`);
      }
    }
    if (low.length > 0) hints.push(`[${si}] uncertain: ${low.join(", ")}`);
  }
  if (hints.length === 0) return "";
  return `\n\nWHISPER CONFIDENCE — these words had low confidence, check them first:\n${hints.join("\n")}`;
}

// ══════════════════════════════════════════════════════════════
// STEP 2B: THE HEBREW EXPERT PROMPTS
// ══════════════════════════════════════════════════════════════
//
// PHILOSOPHY: Don't give Haiku a "bug list" — give it EXPERTISE.
// Teach it to think like a Hebrew linguist who reads, understands,
// and decodes. The prompt covers ALL of Hebrew, not specific domains.
//

function buildPass1Prompt(): string {
  return `אתה מומחה בלשנות עברית שמתקן פלט של Whisper (זיהוי דיבור).

═══════════════════════════════════════════════
שיטת העבודה שלך — קרא, הבן, חשוב, תקן:
═══════════════════════════════════════════════

שלב 1 — קרא את כל הטקסט מההתחלה לסוף. הבן את הנושא, הסגנון, מי המדבר, מה ההקשר.
שלב 2 — חזור לתחילת הטקסט. עבור מילה מילה. לכל מילה שאל:
  • האם המילה הזו קיימת בעברית?
  • האם היא הגיונית בהקשר הזה?
  • אם לא — מה המילה שנשמעת דומה ומתאימה להקשר?
שלב 3 — ודא שלא שינית מילים תקינות. רק מילים שהן שגיאת פענוח.

═══════════════════════════════════════════════
חוק ברזל — מספר המילים בכל שורה חייב להישאר זהה!
(3w) בקלט = (3w) בפלט. לעולם אל תוסיף, תמחק, תפצל או תמזג מילים.
גרשיים לא יוצרים מילה חדשה: רמבם → רמב"ם = מילה אחת.
═══════════════════════════════════════════════

פורמט: [index] טקסט מתוקן — שורה לכל סגמנט, בלי לדלג.

══════════════════════════════════════════════════════════════
טבלת החלפות פונטיות — אותיות שנשמעות דומה בעברית:
══════════════════════════════════════════════════════════════

קבוצה 1 — גרוניות (נשמעות זהות בהגייה מודרנית):
א ↔ ע : עשה/אשה, על/אל, עם/אם, ענן/אנן, עוד/אוד, עין/אין
ח ↔ כ : חזק/כזק, חשב/כשב, חיים/כיים, חם/כם
ה ↔ ח : הס/חס, הולם/חולם, הר/חר, הוק/חוק, הזר/חזר

קבוצה 2 — שיניות/חיכיות:
ט ↔ ת : טוב/תוב, טבע/תבע, טהור/תהור, טיפש/תיפש
ס ↔ ש : סיפור/שיפור, סגר/שגר, סער/שער, סכל/שכל
צ ↔ ס : צד/סד, צער/סער, צפון/ספון
ז ↔ ס ↔ ש : (נדיר — רק בהגייה לא ברורה)

קבוצה 3 — שפתיות:
ב ↔ ו : (נדיר בעברית, שכיח בערבית)
ב ↔ פ : (נדיר — רק כשהדובר לא ברור)
כ ↔ ק : כיסא/קיסא, כרוב/קרוב, כיסוי/קיסוי

קבוצה 4 — אותיות "רפות":
ד ↔ ת : דקיקות/תקיקות, דרש/תרש (נדיר)
ג ↔ כ : (נדיר מאוד)

══════════════════════════════════════════════════════════════
שגיאות מורפולוגיות — תחיליות וסיומות:
══════════════════════════════════════════════════════════════

Whisper לפעמים מפרק/ממזג תחיליות שלא כדין:
ב+מילה: בבית (בֵּית) ≠ ב+בית — אל תפצל
ש+מילה: שאמר ≠ ש+אמר — אל תפצל
ה+מילה: המלך ≠ ה+מלך — אל תפצל
מ+מילה: מהבית ≠ מ+ה+בית — אל תפצל
ו+מילה: ואמר ≠ ו+אמר — אל תפצל

אותיות רפאים — Whisper מוסיף אותיות שלא קיימות:
האישועות → הישועות (א' מיותרת)
ואישועה → וישועה (א' מיותרת)
אהולך → הולך (א' מיותרת)
אוהזר → חזר (א' מיותרת + ה→ח)

══════════════════════════════════════════════════════════════
קיצורים וגרשיים — תמיד מילה אחת:
══════════════════════════════════════════════════════════════

רבניים: שליטא→שליט"א, זצל→זצ"ל, זיעא→זיע"א, נע→נ"ע, עה→ע"ה
חכמים: רמבם→רמב"ם, רשי→רש"י, חזל→חז"ל, שס→ש"ס, שות→שו"ת, שוע→שו"ע
מקרא: תנך→תנ"ך, רמח→רמ"ח, תריג→תרי"ג
צבאי: צהל→צה"ל, אמן→אמ"ן, שבכ→שב"כ, מגב→מג"ב, חיר→חי"ר
דרגות: רבט→רב"ט, סמר→סמ"ר, רסן→רס"ן, סאל→סא"ל, אלמ→אל"מ, תאל→תא"ל
מקצועי: עוד→עו"ד, דר→ד"ר, רוח→רו"ח, שבס→שב"ס
אחר: בגץ→בג"ץ, בנט→בנ"ט(?), מהט→מה"ט

══════════════════════════════════════════════════════════════
ביטויים קבועים — אם מחצית הביטוי נכון, תקן את השני:
══════════════════════════════════════════════════════════════

ברכות: ברוך השם, בעזרת השם, אם ירצה השם, חס ושלום, חס וחלילה
ברכות שם: עליו השלום, עליה השלום, זכרונו לברכה, יבדל לחיים טובים
כבוד: יישר כוח (לא ישר כח), כל הכבוד, חזק וברוך
מסורת: תורה ומצוות, קדושה וטהרה, דין ורחמים, חסד ואמת
חולין: רפואה שלמה, בריאות איתנה, בשעה טובה ומוצלחת
משפטי: על פי חוק, בהתאם לסעיף, לאור האמור, מכאן ומכאן, אי לכך
אקדמי: לאור מחקרים, על פי הממצאים, בהשוואה ל, לסיכום
יומיומי: מה שלומך, מה קורה, מה נשמע, יום טוב, לילה טוב, סוף שבוע

══════════════════════════════════════════════════════════════
התאמת מין ומספר — סימן לשגיאה:
══════════════════════════════════════════════════════════════

אם הנושא זכר → הפועל חייב להיות בזכר: הוא הלכה → הוא הלך
אם הנושא נקבה → הפועל בנקבה: היא אמר → היא אמרה
רבים: הם הלך → הם הלכו, הילדים רוצה → הילדים רוצים
שם עצם + תואר: בית גדולה → בית גדול, עיר גדול → עיר גדולה
אבל: זה שפה טבעית! אם מישהו אמר "הם הולך" בכוונה (דיבור חופשי) → השאר.
תקן רק כשברור שWhisper טעה, לא כשהדובר דיבר חופשי.

══════════════════════════════════════════════════════════════
הומופונים — רק ההקשר מכריע:
══════════════════════════════════════════════════════════════

שם (name) ↔ שם (there) — ההקשר מחליט
על (on) ↔ עָל (yoke) — ההקשר מחליט
לב (heart) ↔ לֵב (name) — ההקשר מחליט
כלי (tool) ↔ כְּלִי (vessel) — ההקשר מחליט
קר (cold) ↔ קָר (read/called) — ההקשר מחליט
אם (if) ↔ אֵם (mother) — ההקשר מחליט
בר (son/outside/grain) — ההקשר מחליט
חי (alive) ↔ חַי (living thing) — ההקשר מחליט

כלל: אם שתי הקריאות אפשריות → השאר את מה שWhisper כתב.
תקן רק כשאחת הקריאות היא חסרת משמעות בהקשר.

══════════════════════════════════════════════════════════════
טקסט זבל — אותיות לטיניות/יווניות מעורבות בעברית:
══════════════════════════════════════════════════════════════

אם סגמנט מכיל תווים לטיניים/יווניים אקראיים → נסה לשחזר מההקשר.
אם אי אפשר → החזר ללא שינוי.
אבל: מילים אנגליות לגיטימיות (API, WhatsApp, iPhone) → השאר!

══════════════════════════════════════════════════════════════
מה אסור לעשות — בשום מצב:
══════════════════════════════════════════════════════════════

❌ לשנות מספר מילים (להוסיף, למחוק, לפצל, למזג)
❌ להחליף מילה תקינה במילה נרדפת (הלך→צעד, גדול→עצום, אמר→ציין)
❌ לשפר סגנון או דקדוק של דיבור חופשי
❌ למחוק מילות מילוי (כאילו, אממ, אה, נו, בוא, סתם, כזה) — אלה עוגני תזמון!
❌ לשנות שמות, מקומות, מותגים
❌ לשנות סדר מילים
❌ להוסיף מילים שלא נאמרו
❌ להפוך עברית מדוברת לעברית ספרותית

══════════════════════════════════════════════════════════════
כלל ההכרעה:
══════════════════════════════════════════════════════════════

המילה קיימת בעברית + יכולה להתאים להקשר → השאר
המילה לא קיימת / חסרת משמעות בהקשר → פענח ותקן
ספק → השאר ללא שינוי

פורמט פלט: [index] טקסט מתוקן — שורה אחת לכל סגמנט.`;
}

function buildPass2Prompt(): string {
  return `אתה מגיה מקצועי. קיבלת טקסט עברי שכבר תוקן פונטית.
תפקידך: להוסיף פיסוק טבעי ולתפוס שגיאות שנשארו.

═══════════════════════════════════════════════
חוק ברזל — מספר המילים בכל שורה חייב להישאר זהה!
פיסוק מתחבר למילה שלפניו: "שלום." = מילה אחת. "שלום ." = שגיאה.
═══════════════════════════════════════════════

פורמט: [index] טקסט מתוקן — שורה אחת לכל סגמנט, בלי לדלג.

══════════════════════════════════════════════════════════════
פיסוק — כללים:
══════════════════════════════════════════════════════════════

נקודה (.) — בסוף משפט שלם. לא בכל שורה! רק כשהמשפט באמת נגמר.
פסיק (,) — בין פסוקיות, אחרי מילת קישור (אבל, כי, אם, כש, כאשר, למרות ש),
             לפני ואחרי משפט מוסגר, ברשימה.
סימן שאלה (?) — רק לשאלות אמיתיות. לא לשאלות רטוריות בתוך דיבור שוטף.
סימן קריאה (!) — רק כשברור שהדובר קרא/הדגיש. שימוש מינימלי.
נקודתיים (:) — לפני ציטוט או רשימה.
מרכאות ("") — לדיבור ישיר, ציטוט, מונח מיוחד.
מקף (—) — למשפט מוסגר, הערת ביניים.

כללי הצמדה:
פיסוק תמיד צמוד למילה שלפניו ← "שלום, מה" ✓ | "שלום , מה" ✗
פיסוק לא יוצר מילה נפרדת ← 3 מילים נשארות 3 מילים אחרי פיסוק

══════════════════════════════════════════════════════════════
תיקוני הקשר — רק מה שPass 1 פספס:
══════════════════════════════════════════════════════════════

קרא שוב את כל הטקסט. אם יש מילה שעדיין לא הגיונית בהקשר — תקן.
אבל: אל תשנה מילים שPass 1 השאיר בכוונה. אם המילה קיימת ויכולה להתאים → השאר.

מה לא לעשות:
❌ לשנות מספר מילים
❌ להחליף מילים בנרדפות
❌ לפרמל שפה מדוברת
❌ למחוק מילות מילוי

פורמט פלט: [index] טקסט מתוקן`;
}

// ══════════════════════════════════════════════════════════════
// STEP 2C: HAIKU API + PARSING
// ══════════════════════════════════════════════════════════════

async function callHaiku(
  input: string,
  systemPrompt: string,
  timeoutMs: number = 30000,
): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: "user", content: input }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`[HAIKU] API error: ${response.status}`);
      return null;
    }

    const result = await response.json();
    return result.content?.[0]?.text || null;
  } catch (e: any) {
    clearTimeout(timeout);
    if (e.name === "AbortError") console.warn(`[HAIKU] Timeout (${timeoutMs}ms)`);
    else console.error("[HAIKU] Error:", e.message);
    return null;
  }
}

function parseCorrections(output: string): Array<{ idx: number; text: string }> {
  const corrected: Array<{ idx: number; text: string }> = [];
  for (const line of output.split("\n")) {
    // Match [index] text  OR  [index|timing] text
    const m = line.match(/\[(\d+)(?:\|[^\]]+)?\]\s*(.*)/);
    if (m && m[2].trim()) {
      corrected.push({ idx: parseInt(m[1]), text: m[2].trim() });
    }
  }
  return corrected;
}

// ══════════════════════════════════════════════════════════════
// STEP 2D: APPLY CORRECTIONS — TIMESTAMP-LOCKED
// ══════════════════════════════════════════════════════════════
//
// GUARANTEE:
// • word.start — NEVER modified (Whisper's original)
// • word.end   — NEVER modified (Whisper's original)
// • seg.start  — NEVER modified (= first word's Whisper start)
// • seg.end    — NEVER modified (= last word's Whisper end)
// • Only word.word (the text string) is replaced
// • If corrected word count ≠ original → ENTIRE segment rejected
//

function applyCorrections(
  segs: TimedSegment[],
  corrections: Array<{ idx: number; text: string }>,
  passName: string,
): { segments: TimedSegment[]; accepted: number; rejected: number } {
  let accepted = 0;
  let rejected = 0;

  const result = segs.map((seg, i) => {
    const correction = corrections.find((c) => c.idx === i);
    if (!correction) return seg;

    const origWords = seg.text.split(/\s+/).filter((w) => w);
    const corrWords = correction.text.split(/\s+/).filter((w) => w);

    // ═══ IRON LAW: word count must be identical ═══
    if (corrWords.length !== origWords.length) {
      console.warn(
        `[${passName}] REJECTED seg ${i} (words ${origWords.length}→${corrWords.length}): "${seg.text.trim()}" → "${correction.text}"`,
      );
      rejected++;
      return seg;
    }

    // Check: did anything actually change? (ignoring punctuation)
    const stripPunct = (w: string) => w.replace(/[.!?,;:"""״'''\-—…·]/g, "");
    const origClean = origWords.map(stripPunct).join(" ");
    const corrClean = corrWords.map(stripPunct).join(" ");

    if (origClean === corrClean) {
      // Punctuation-only change → always accept
      if (seg.text.trim() !== correction.text) {
        accepted++;
        const newWords = seg.words.map((w, wi) => ({
          start: w.start,             // ← LOCKED
          end: w.end,                 // ← LOCKED
          probability: w.probability, // ← PRESERVED
          word: wi < corrWords.length ? corrWords[wi] : w.word,
        }));
        return { start: seg.start, end: seg.end, text: correction.text, words: newWords };
      }
      return seg;
    }

    // Substantive text change → Levenshtein check
    const dist = levenshtein(origClean, corrClean);
    const garbage = isGarbageSegment(seg.text);
    const threshold = garbage ? 0.85 : 0.4;

    if (dist > threshold) {
      console.warn(
        `[${passName}] REJECTED seg ${i} (lev ${(dist * 100).toFixed(0)}%): "${seg.text.trim()}" → "${correction.text}"`,
      );
      rejected++;
      return seg;
    }

    // ═══ ACCEPTED — replace ONLY word text, timestamps UNTOUCHED ═══
    console.log(
      `[${passName}] OK seg ${i} (${(dist * 100).toFixed(0)}%): "${seg.text.trim()}" → "${correction.text}"`,
    );
    accepted++;

    const newWords = seg.words.map((w, wi) => ({
      start: w.start,             // ← LOCKED
      end: w.end,                 // ← LOCKED
      probability: w.probability, // ← PRESERVED
      word: wi < corrWords.length ? corrWords[wi] : w.word,
    }));

    return {
      start: seg.start, // ← LOCKED
      end: seg.end,     // ← LOCKED
      text: correction.text,
      words: newWords,
    };
  });

  return { segments: result, accepted, rejected };
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return 1;
  if (!b.length) return 1;
  const m: number[][] = [];
  for (let i = 0; i <= a.length; i++) m[i] = [i];
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return m[a.length][b.length] / Math.max(a.length, b.length);
}

// ══════════════════════════════════════════════════════════════
// STEP 2E: MULTI-PASS ORCHESTRATOR
// ══════════════════════════════════════════════════════════════

async function aiCorrectMultiPass(
  timedSegs: TimedSegment[],
  language: string,
): Promise<{ segments: TimedSegment[]; method: string }> {
  if (!ANTHROPIC_API_KEY || timedSegs.length === 0) {
    return { segments: timedSegs, method: "none" };
  }

  if (language !== "he") {
    return aiCorrectSinglePass(timedSegs, language);
  }

  try {
    const confHints = buildConfidenceHints(timedSegs);

    // Format input with word counts for Haiku to verify
    const formatInput = (segs: TimedSegment[]) =>
      segs.map((s, i) => {
        const wc = s.text.split(/\s+/).filter((w) => w).length;
        return `[${i}] (${wc}w) ${s.text}`;
      }).join("\n");

    let currentSegs = timedSegs;
    let totalAccepted = 0;
    let totalRejected = 0;

    // ══════════════════════════════════════════
    // PASS 1: Read → Understand → Decode → Fix
    // ══════════════════════════════════════════
    console.log(`[AI] Pass 1 (Hebrew expert decode) — ${timedSegs.length} segs`);
    const pass1Prompt = buildPass1Prompt();
    const pass1Input = formatInput(currentSegs) + confHints;
    const pass1Output = await callHaiku(pass1Input, pass1Prompt, 35000);

    if (pass1Output) {
      const corr1 = parseCorrections(pass1Output);
      if (corr1.length > 0 && Math.abs(corr1.length - currentSegs.length) <= currentSegs.length * 0.3) {
        const r1 = applyCorrections(currentSegs, corr1, "PASS1");
        currentSegs = r1.segments;
        totalAccepted += r1.accepted;
        totalRejected += r1.rejected;
        console.log(`[AI] Pass 1: ${r1.accepted} accepted, ${r1.rejected} rejected`);
      } else {
        console.warn(`[AI] Pass 1 integrity fail: expected ~${currentSegs.length}, got ${corr1.length}`);
      }
    }

    // ══════════════════════════════════════════
    // PASS 2: Punctuation + Context refinement
    // ══════════════════════════════════════════
    console.log(`[AI] Pass 2 (punctuation + context) — ${currentSegs.length} segs`);
    const pass2Prompt = buildPass2Prompt();
    const pass2Input = formatInput(currentSegs);
    const pass2Output = await callHaiku(pass2Input, pass2Prompt, 25000);

    if (pass2Output) {
      const corr2 = parseCorrections(pass2Output);
      if (corr2.length > 0 && Math.abs(corr2.length - currentSegs.length) <= currentSegs.length * 0.3) {
        const r2 = applyCorrections(currentSegs, corr2, "PASS2");
        currentSegs = r2.segments;
        totalAccepted += r2.accepted;
        totalRejected += r2.rejected;
        console.log(`[AI] Pass 2: ${r2.accepted} accepted, ${r2.rejected} rejected`);
      }
    }

    console.log(`[AI] TOTAL: ${totalAccepted} accepted, ${totalRejected} rejected`);
    return { segments: currentSegs, method: `claude_2pass` };
  } catch (e: any) {
    console.error("[AI] Error:", e.message || e);
    return { segments: timedSegs, method: "error_fallback" };
  }
}

async function aiCorrectSinglePass(
  timedSegs: TimedSegment[],
  language: string,
): Promise<{ segments: TimedSegment[]; method: string }> {
  const langName = language === "ar" ? "Arabic" : "English";
  const prompt = `Fix ${langName} Whisper transcription errors. Add proper punctuation.

CRITICAL: Every output segment MUST have EXACTLY the same word count as input.
NEVER add or remove words. Punctuation attaches to the preceding word.

Format: [index] corrected text — one per line, every segment.`;

  const input = timedSegs.map((s, i) => {
    const wc = s.text.split(/\s+/).filter((w) => w).length;
    return `[${i}] (${wc}w) ${s.text}`;
  }).join("\n");

  const output = await callHaiku(input, prompt, 30000);
  if (!output) return { segments: timedSegs, method: "api_error" };

  const corrections = parseCorrections(output);
  if (corrections.length === 0) return { segments: timedSegs, method: "empty_response" };

  const { segments, accepted, rejected } = applyCorrections(timedSegs, corrections, "SINGLE");
  console.log(`[AI] Single-pass: ${accepted} accepted, ${rejected} rejected`);
  return { segments, method: accepted > 0 ? "claude_single" : "no_changes" };
}

// ══════════════════════════════════════════════════════════════
// STEP 3: SPLITTING — breaks only, timestamps from Whisper
// ══════════════════════════════════════════════════════════════

function applySplitting(segs: TimedSegment[], style: string, wpg: number): Segment[] {
  const all: Word[] = [];
  for (const s of segs) for (const w of s.words) all.push(w);
  if (all.length === 0) return segs;

  if (style === "sentence") return splitSentence(all);
  if (style && style.startsWith("word")) {
    const n = parseInt(style.replace("word", "")) || wpg || 1;
    return splitWords(all, Math.max(1, Math.min(6, n)));
  }
  return splitAuto(all);
}

function mkSeg(words: Word[]): Segment {
  return {
    start: words[0].start,
    end: words[words.length - 1].end,
    text: words.map((w) => w.word).join(" "),
  };
}

function splitSentence(all: Word[]): Segment[] {
  const r: Segment[] = [];
  let c: Word[] = [];
  for (const w of all) {
    c.push(w);
    if (/[.!?]$/.test(w.word.trim())) { r.push(mkSeg(c)); c = []; }
  }
  if (c.length > 0) r.push(mkSeg(c));
  return r;
}

function splitWords(all: Word[], gs: number): Segment[] {
  const r: Segment[] = [];
  let c: Word[] = [];
  for (let i = 0; i < all.length; i++) {
    c.push(all[i]);
    if (c.length >= gs) {
      if (i + 1 < all.length && isBound(all[i], all[i + 1]) && c.length < gs + 2) continue;
      r.push(mkSeg(c)); c = [];
    }
  }
  if (c.length > 0) r.push(mkSeg(c));
  return r;
}

function splitAuto(all: Word[]): Segment[] {
  const SOFT = 38, HARD = 50, MAXD = 4;
  const r: Segment[] = [];
  let c: Word[] = [];
  let ct = "";

  for (let i = 0; i < all.length; i++) {
    const w = all[i];
    c.push(w);
    ct = ct ? ct + " " + w.word : w.word;
    const dur = c.length > 1 ? w.end - c[0].start : 0;

    if (/[.!?]$/.test(w.word.trim())) { r.push(mkSeg(c)); c = []; ct = ""; continue; }
    if (/,$/.test(w.word.trim()) && ct.length >= 20) { r.push(mkSeg(c)); c = []; ct = ""; continue; }

    if (ct.length >= SOFT && c.length >= 2) {
      const chain = countChain(all, i + 1);
      if (chain === 0) { r.push(mkSeg(c)); c = []; ct = ""; continue; }
      let extra = 0;
      for (let x = 1; x <= chain && i + x < all.length; x++) extra += all[i + x].word.length + 1;
      if (ct.length + extra <= HARD) continue;
      const lb = countTail(c);
      if (lb > 0 && c.length - lb >= 2) {
        r.push(mkSeg(c.slice(0, c.length - lb)));
        c = c.slice(c.length - lb);
        ct = c.map((w) => w.word).join(" ");
        continue;
      }
      r.push(mkSeg(c)); c = []; ct = ""; continue;
    }

    if (ct.length >= HARD || dur >= MAXD) { r.push(mkSeg(c)); c = []; ct = ""; continue; }
  }
  if (c.length > 0) r.push(mkSeg(c));
  return r;
}

function isBound(a: Word, b: Word): boolean {
  const wa = a.word.trim().replace(/[,.:;!?"״""—…]+$/g, "");
  const wb = b.word.trim().replace(/[,.:;!?"״""—…]+$/g, "");

  // Titles
  if ([
    "הרב","הגאון","הרבנית","מורנו","ורבנו","המקובל","הצדיק",
    "ר'","רבי","רבנו","מרן","כבוד","כ\"ק",
    "דר","ד\"ר","פרופ","פרופ'","מר","גב","גב'","עו\"ד",
    "השר","השרה","הנשיא","הנשיאה","ראש","סגן",
    "אלוף","תא\"ל","אל\"מ","סא\"ל","רס\"ן","סרן","סגן",
  ].includes(wa)) return true;

  // Negation
  if (["לא","אל","אין","בלי","ללא","אינו","אינה","אינם","אינן","איננו"].includes(wa)) return true;

  // Definite article
  if (!wa.startsWith("ה") && wb.startsWith("ה") && wb.length > 2) return true;

  // Prepositions, conjunctions, relatives
  if ([
    "את","של","על","אל","עם","בת","בן","כל","גם","רק","כי","אם","או","כמו",
    "ו","וגם","אבל","אלא","אך","אולם","לכן","משום","מפני","בגלל","למרות",
    "בין","לבין","כדי","כאשר","כש","לכש","מש","ש","שלא","עד","מול","נגד",
    "לפי","אצל","בשביל","למען","כלפי","מתוך","בתוך","מאחורי","לפני","אחרי",
  ].includes(wa)) return true;

  // של after noun
  if (wb === "של") return true;

  // Numbers
  if (/^\d+$/.test(wa)) return true;

  // Honorific suffixes
  if ([
    'שליט"א','שליטא','זצ"ל','זצל','זיע"א','נ"ע','ע"ה','הי"ד','יבדל"א',
  ].some((h) => wb.replace(/[""״]/g, '"') === h)) return true;

  // Smichut pairs
  if (wa === "בית" && ["ספר","חולים","כנסת","משפט","דין","מדרש","עלמין"].includes(wb)) return true;
  if (wa === "ארץ" && wb === "ישראל") return true;
  if (wa === "חוק" && wb === "יסוד") return true;
  if (wa === "ראש" && ["הממשלה","העיר","ישיבה","השנה","חודש"].includes(wb)) return true;
  if (wa === "בני" && ["אדם","ישראל","ברק","תורה"].includes(wb)) return true;

  return false;
}

function countChain(w: Word[], si: number): number {
  let c = 0, i = si;
  while (i < w.length && i > 0 && isBound(w[i - 1], w[i])) { c++; i++; }
  return c;
}

function countTail(c: Word[]): number {
  if (c.length < 2) return 0;
  let n = 0;
  for (let i = c.length - 1; i >= 1; i--) {
    const a = c[i].word.trim().replace(/[,.:;!?]+$/g, "");
    if ([
      "הרב","הגאון","מורנו","ורבנו","המקובל","לא","אל","אין",
      "את","של","על","אל","עם","כל","גם","כי","ש","כש",
      "ו","וגם","אבל","אלא","בין","כדי","כאשר",
    ].includes(a)) n++;
    else break;
  }
  return n;
}

// ══════════════════════════════════════════════════════════════
// SRT BUILDER (RTL)
// ══════════════════════════════════════════════════════════════

function buildSrt(segs: Segment[], lang: string = "he"): string {
  const rtl = lang === "he" || lang === "ar";
  const RLM = "\u200F";
  const ts = (s: number) => {
    s = Math.max(0, s);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sc = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sc).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
  };
  return segs
    .map((seg, i) => {
      const t = seg.text.trim();
      if (!t) return "";
      return `${i + 1}\n${ts(seg.start)} --> ${ts(seg.end)}\n${rtl ? RLM + t : t}\n`;
    })
    .filter(Boolean)
    .join("\n");
}

// ══════════════════════════════════════════════════════════════
// RATE LIMITING
// ══════════════════════════════════════════════════════════════

const rateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60000;

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(userId);
  if (rateLimits.size > 1000) {
    for (const [k, v] of rateLimits) { if (v.resetAt < now) rateLimits.delete(k); }
  }
  if (!entry || entry.resetAt < now) {
    rateLimits.set(userId, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// ══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { api_key, action, lang, model, offset, audio_duration, caption_style, words_per_group } = body;

    if (!api_key) return err("Missing api_key", 401);
    if (typeof api_key !== "string" || api_key.length < 10 || api_key.length > 200) {
      return err("Invalid API key format", 401);
    }

    const user = await validateApiKey(api_key);
    if (!user) return err("Invalid API key", 401);

    const remaining = (user.minutes_limit || 0) - (user.minutes_used || 0);
    if (remaining <= 0) return err("נגמרה המכסה. שדרג תוכנית.", 403);

    if (action === "transcribe" || action === "get_upload_url") {
      if (!checkRateLimit(user.id)) {
        return err("יותר מדי בקשות. נסה שוב בעוד דקה.", 429);
      }
    }

    if (action === "get_upload_url") {
      const fileKey = `audio/${user.id}/${Date.now()}.mp3`;
      const putCmd = new PutObjectCommand({ Bucket: S3_BUCKET, Key: fileKey, ContentType: "audio/mpeg" });
      const uploadUrl = await getSignedUrl(s3, putCmd, { expiresIn: 300 });
      const getCmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: fileKey });
      const downloadUrl = await getSignedUrl(s3, getCmd, { expiresIn: 3600 });
      return NextResponse.json({
        upload_url: uploadUrl, download_url: downloadUrl,
        file_key: fileKey, remaining_minutes: remaining,
      });
    }

    if (action === "transcribe") {
      const { download_url, file_key } = body;
      if (!download_url) return err("Missing download_url");
      const audioDur = audio_duration || 0;
      if (Math.ceil((audioDur / 60) * 10) / 10 > remaining) return err("לא מספיק דקות.", 403);
      if (audioDur > 3600) return err("מקסימום 60 דקות לתמלול בודד.", 400);

      // ── STEP 1: Modal Whisper ──
      console.log("[MODAL] Sending to Whisper...");
      const t0 = Date.now();

      const modalRes = await fetch(MODAL_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio_url: download_url, lang: lang || "he" }),
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
        await logUsage(user.id, audioDur, lang || "he", "whisper-large-v3", "failed", 0, 0, mr.error);
        return err("שגיאת תמלול: " + mr.error, 500);
      }

      console.log(`[MODAL] Done ${whisperMs}ms — ${mr.segments?.length || 0} segs, ${mr.words?.length || 0} words`);

      const rawSegs: Segment[] = (mr.segments || []).map((s: any) => ({
        start: s.start, end: s.end, text: (s.text || "").trim(),
      }));
      const rawWords: Word[] = (mr.words || []).map((w: any) => ({
        start: w.start, end: w.end, word: (w.word || "").trim(),
        probability: w.probability,
      }));

      if (rawSegs.length === 0) {
        await logUsage(user.id, audioDur, lang || "he", "whisper-large-v3", "empty", 0, 0);
        return err("לא נמצא דיבור.", 200);
      }

      // ── STEP 1.5: Filter hallucinations ──
      const hePrompt = lang === "he"
        ? "שלום, זהו תמלול מקצועי בעברית תקנית. סימני פיסוק: נקודה, פסיק, סימן שאלה. שמות אנשים, מקומות ומונחים מקצועיים נכתבים במדויק."
        : "";
      const cleaned = filterHallucinations(rawSegs, rawWords, hePrompt);

      if (cleaned.segments.length === 0) {
        await logUsage(user.id, audioDur, lang || "he", "whisper-large-v3", "empty", 0, 0);
        return err("לא נמצא דיבור.", 200);
      }

      // ── STEP 2: Build timed segments (timestamps LOCKED from here) ──
      const timedSegs = buildTimedSegments(cleaned.segments, cleaned.words);

      // ── STEP 3: AI Correction (TEXT ONLY — timestamps LOCKED) ──
      const aiResult = await aiCorrectMultiPass(timedSegs, lang || "he");

      // NOTE: No repairBoundaries — timestamps are never modified

      // ── STEP 4: Split ──
      const wpg = parseInt(words_per_group) || 1;
      const final = applySplitting(aiResult.segments, caption_style || "auto", wpg);

      // ── STEP 5: Build SRT ──
      const srt = buildSrt(final, lang || "he");

      // ── STEP 6: Log & deduct ──
      const totalMs = Date.now() - t0;
      const mins = await logUsage(
        user.id, audioDur, lang || "he", "whisper-large-v3",
        "completed", final.length, totalMs / 1000,
      );
      await deductMinutes(user.id, mins);

      if (file_key) {
        s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: file_key })).catch(() => {});
      }

      console.log(`[DONE] ${final.length} segs, ${totalMs}ms (Whisper:${whisperMs}ms, AI:${totalMs - whisperMs}ms)`);

      return NextResponse.json({
        ok: true, status: "completed", segments: final, srt,
        language: mr.language || lang, elapsed: (totalMs / 1000).toFixed(1),
        count: final.length, minutes_charged: mins,
        minutes_remaining: remaining - mins, ai_correction: aiResult.method,
      });
    }

    if (action === "check_job") {
      return NextResponse.json({ ok: true, status: "completed", message: "Modal is synchronous" });
    }

    if (action === "status") {
      return NextResponse.json({
        ok: true, plan: user.plan, minutes_used: user.minutes_used,
        minutes_limit: user.minutes_limit, minutes_remaining: remaining,
      });
    }

    return err("Unknown action");
  } catch (e: any) {
    console.error("API Error:", e);
    return err("שגיאה פנימית", 500);
  }
}
