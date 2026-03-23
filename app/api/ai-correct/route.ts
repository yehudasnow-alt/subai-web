/**
 * SubAI — AI Text Correction
 * POST /api/ai-correct
 * 
 * Takes Whisper segments, sends to Claude for:
 * - Fix Hebrew grammar and punctuation
 * - Fix common Whisper errors (hallucinations, repeated words)
 * - Maintain original timing
 * - Smart sentence splitting based on style (auto/word/sentence)
 */

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

interface Segment {
  start: number;
  end: number;
  text: string;
}

export async function POST(req: NextRequest) {
  try {
    const { segments, language, caption_style } = await req.json();

    if (!segments || segments.length === 0) {
      return NextResponse.json({ error: "No segments provided" }, { status: 400 });
    }

    if (!ANTHROPIC_API_KEY) {
      // No API key — return segments as-is with basic cleanup
      const cleaned = basicCleanup(segments, caption_style);
      return NextResponse.json({ ok: true, segments: cleaned, method: "basic" });
    }

    // Build the full text with segment markers for Claude
    const fullText = segments.map((s: Segment, i: number) => 
      `[${i}|${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`
    ).join("\n");

    const langName = language === "he" ? "עברית" : language === "ar" ? "ערבית" : "English";
    const styleInstruction = getStyleInstruction(caption_style);

    const systemPrompt = `You are a professional subtitle editor. You receive AI-transcribed text (from Whisper) and fix it.

Rules:
1. Fix grammar, punctuation, and spelling errors
2. Remove hallucinated/repeated text (Whisper sometimes repeats phrases)
3. Remove filler words if they don't add meaning
4. Keep the EXACT same timing markers [index|start-end]
5. Keep the original language (${langName})
6. Do NOT translate or change the meaning
7. Do NOT add content that wasn't spoken
8. ${styleInstruction}
9. Return ONLY the corrected segments in the exact same format, nothing else`;

    const userPrompt = `Fix this transcription:\n\n${fullText}`;

    // Call Claude API
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!response.ok) {
      console.error("Claude API error:", response.status);
      // Fallback to basic cleanup
      const cleaned = basicCleanup(segments, caption_style);
      return NextResponse.json({ ok: true, segments: cleaned, method: "basic_fallback" });
    }

    const result = await response.json();
    const correctedText = result.content?.[0]?.text || "";

    // Parse corrected segments back
    const correctedSegments = parseCorrectedSegments(correctedText, segments);

    // Apply caption style splitting
    const styledSegments = applyStyle(correctedSegments, caption_style);

    return NextResponse.json({ ok: true, segments: styledSegments, method: "claude" });

  } catch (e: any) {
    console.error("AI Correct error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

function getStyleInstruction(style: string): string {
  switch (style) {
    case "word1":
      return "Split each segment into individual words. Each word gets its own timing (distribute time proportionally by word length).";
    case "word2":
      return "Split each segment into pairs of 2 words. Each pair gets its own timing.";
    case "sentence":
      return "Keep full sentences together. Merge short segments that are part of the same sentence.";
    default:
      return "Split naturally at punctuation marks (periods, commas, question marks). Max 42 characters per subtitle. Max 4 seconds per subtitle.";
  }
}

function basicCleanup(segments: Segment[], style: string): Segment[] {
  // Remove duplicates and clean text without AI
  const cleaned: Segment[] = [];
  let prevText = "";
  
  for (const seg of segments) {
    let text = seg.text.trim();
    // Remove exact duplicates
    if (text === prevText) continue;
    // Remove very short meaningless segments
    if (text.length < 2) continue;
    // Remove common Whisper artifacts
    text = text.replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim();
    if (!text) continue;
    
    cleaned.push({ start: seg.start, end: seg.end, text });
    prevText = text;
  }

  return applyStyle(cleaned, style);
}

function parseCorrectedSegments(text: string, original: Segment[]): Segment[] {
  const lines = text.split("\n").filter(l => l.trim());
  const segments: Segment[] = [];

  for (const line of lines) {
    // Parse format: [index|start-end] text
    const match = line.match(/\[(\d+)\|([\d.]+)-([\d.]+)\]\s*(.*)/);
    if (match) {
      segments.push({
        start: parseFloat(match[2]),
        end: parseFloat(match[3]),
        text: match[4].trim(),
      });
    }
  }

  // If parsing failed, return original
  if (segments.length === 0) return original;
  return segments;
}

function applyStyle(segments: Segment[], style: string): Segment[] {
  if (!style || style === "auto") return segments;

  const result: Segment[] = [];

  for (const seg of segments) {
    const dur = seg.end - seg.start;
    const words = seg.text.split(/\s+/).filter(w => w);

    if (style === "word1") {
      // Each word gets its own subtitle
      const totalChars = words.reduce((sum, w) => sum + w.length, 0);
      let currentTime = seg.start;
      for (const word of words) {
        const ratio = word.length / totalChars;
        const wordDur = dur * ratio;
        result.push({
          start: Math.round(currentTime * 1000) / 1000,
          end: Math.round((currentTime + wordDur) * 1000) / 1000,
          text: word,
        });
        currentTime += wordDur;
      }
    } else if (style === "word2") {
      // Pairs of 2 words
      const totalChars = words.reduce((sum, w) => sum + w.length, 0);
      let currentTime = seg.start;
      for (let i = 0; i < words.length; i += 2) {
        const pair = words.slice(i, i + 2).join(" ");
        const pairChars = pair.replace(/\s/g, "").length;
        const ratio = pairChars / totalChars;
        const pairDur = dur * ratio;
        result.push({
          start: Math.round(currentTime * 1000) / 1000,
          end: Math.round((currentTime + pairDur) * 1000) / 1000,
          text: pair,
        });
        currentTime += pairDur;
      }
    } else if (style === "sentence") {
      // Keep as-is (already sentence-level from Whisper)
      result.push(seg);
    } else {
      result.push(seg);
    }
  }

  return result;
}
