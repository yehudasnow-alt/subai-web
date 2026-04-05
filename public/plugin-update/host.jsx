/* ═══════════════════════════════════════════════════════════════
   host.jsx — SubAI v4.0 — Production Build
   ExtendScript host for Adobe Premiere Pro CEP panel
   ═══════════════════════════════════════════════════════════════ */

// ── Response Helpers ──────────────────────────────────────────

function _ok(obj) {
    var result = { ok: true };
    if (obj) {
        for (var key in obj) {
            if (obj.hasOwnProperty(key)) {
                result[key] = obj[key];
            }
        }
    }
    return JSON.stringify(result);
}

function _er(message) {
    return JSON.stringify({ ok: false, e: String(message) });
}

// ── Sequence Resolver ─────────────────────────────────────────

function _getActiveSequence() {
    var seq = null;
    try {
        seq = app.project.activeSequence;
    } catch (e) { /* no active sequence */ }

    if (!seq) {
        try {
            if (app.project.sequences && app.project.sequences.numSequences > 0) {
                seq = app.project.sequences[0];
            }
        } catch (e) { /* no sequences at all */ }
    }
    return seq;
}

// ── Framerate Detection ───────────────────────────────────────

function _getSequenceFPS(seq) {
    var fps = 25;
    try {
        var settings = seq.getSettings();
        if (settings.videoFrameRate && settings.videoFrameRate.seconds > 0) {
            fps = Math.round(1 / settings.videoFrameRate.seconds);
        }
    } catch (e) { /* fallback to 25 */ }
    return fps;
}

// ── Ticks-to-Seconds Conversion ──────────────────────────────
// Premiere Pro uses ticks internally (254016000000 ticks/sec)

var TICKS_PER_SECOND = 254016000000;
var MAX_SAFE_TICKS = 4503599627370000;

function _ticksToSeconds(ticks, timebase) {
    if (isNaN(ticks) || ticks <= 0) return -1;
    if (ticks >= MAX_SAFE_TICKS) return -1;

    // Try ticks-based conversion first (most accurate)
    var viaTicks = ticks / TICKS_PER_SECOND;

    // Sanity check: also try timebase division
    var viaTimebase = (timebase > 0) ? (ticks / timebase) : -1;

    // Return the more plausible value
    if (viaTicks >= 0 && viaTicks < 86400) return viaTicks;  // < 24 hours
    if (viaTimebase >= 0 && viaTimebase < 86400) return viaTimebase;
    return -1;
}

// ── In/Out Point Reader (robust, multi-API) ──────────────────

function _readInOutPoints(seq, duration) {
    var inPt = 0;
    var outPt = duration;
    var timebase = parseFloat(seq.timebase) || 1;

    // Method 1: getInPointAsTime / getOutPointAsTime (preferred — returns Time object)
    try {
        var inTime = seq.getInPointAsTime();
        if (inTime && typeof inTime.seconds !== 'undefined'
            && inTime.seconds >= 0 && inTime.seconds < duration) {
            inPt = inTime.seconds;
        }
    } catch (e) { /* API not available */ }

    try {
        var outTime = seq.getOutPointAsTime();
        if (outTime && typeof outTime.seconds !== 'undefined'
            && outTime.seconds > 0 && outTime.seconds <= duration) {
            outPt = outTime.seconds;
        }
    } catch (e) { /* API not available */ }

    // Method 2: getInPoint / getOutPoint (returns ticks — fallback)
    if (inPt === 0 && outPt === duration) {
        try {
            var rawIn = parseFloat(seq.getInPoint());
            if (!isNaN(rawIn) && rawIn > 0) {
                var secIn = _ticksToSeconds(rawIn, timebase);
                if (secIn >= 0 && secIn < duration) {
                    inPt = secIn;
                }
            }
        } catch (e) { /* */ }

        try {
            var rawOut = parseFloat(seq.getOutPoint());
            if (!isNaN(rawOut) && rawOut > 0) {
                var secOut = _ticksToSeconds(rawOut, timebase);
                if (secOut > 0 && secOut <= duration * 1.01) {
                    outPt = Math.min(secOut, duration);
                }
            }
        } catch (e) { /* */ }
    }

    // Validation
    if (outPt <= inPt) {
        inPt = 0;
        outPt = duration;
    }

    return {
        inPoint:  Math.round(inPt  * 1000) / 1000,
        outPoint: Math.round(outPt * 1000) / 1000
    };
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API — called from CEP panel via evalScript
// ═══════════════════════════════════════════════════════════════

/**
 * getSeq() — Returns active sequence metadata including In/Out points
 */
function getSeq() {
    try {
        var seq = _getActiveSequence();
        if (!seq) return _er("אין רצף פעיל — פתח רצף ב-Premiere Pro");

        var timebase = parseFloat(seq.timebase) || 1;
        var duration = parseFloat(seq.end) / timebase;
        if (isNaN(duration) || duration <= 0) duration = 0;

        var fps = _getSequenceFPS(seq);
        var io  = _readInOutPoints(seq, duration);

        var hasWorkArea = (io.outPoint - io.inPoint) > 0.5
                       && (io.inPoint > 0.5 || (duration - io.outPoint) > 0.5);

        return _ok({
            name:  seq.name || "רצף",
            dur:   Math.round(duration * 1000) / 1000,
            fps:   fps,
            i:     io.inPoint,
            o:     io.outPoint,
            hasWA: hasWorkArea
        });
    } catch (e) {
        return _er(e.toString());
    }
}

/**
 * getInOut() — Lightweight In/Out refresh (polled from panel)
 */
function getInOut() {
    try {
        var seq = _getActiveSequence();
        if (!seq) return _er("no seq");

        var timebase = parseFloat(seq.timebase) || 1;
        var duration = parseFloat(seq.end) / timebase;
        if (isNaN(duration) || duration <= 0) duration = 0;

        var io = _readInOutPoints(seq, duration);
        var hasWorkArea = (io.outPoint - io.inPoint) > 0.5
                       && (io.inPoint > 0.5 || (duration - io.outPoint) > 0.5);

        return _ok({
            i:     io.inPoint,
            o:     io.outPoint,
            hasWA: hasWorkArea,
            dur:   Math.round(duration * 1000) / 1000
        });
    } catch (e) {
        return _er(e.toString());
    }
}

// ── Audio Track Management ────────────────────────────────────

/**
 * getAudioTracks() — Lists all audio tracks with clip info
 */
function getAudioTracks() {
    try {
        var seq = _getActiveSequence();
        if (!seq) return _er("no seq");

        var tracks = [];
        for (var t = 0; t < seq.audioTracks.numTracks; t++) {
            var track = seq.audioTracks[t];
            var clipCount = 0;
            var clipNames = [];

            try {
                clipCount = track.clips.numItems;
                for (var c = 0; c < Math.min(clipCount, 5); c++) {
                    try { clipNames.push(track.clips[c].name); } catch (e) { /* */ }
                }
            } catch (e) { /* */ }

            tracks.push({
                index:     t,
                name:      track.name || ("A" + (t + 1)),
                muted:     track.isMuted(),
                clipCount: clipCount,
                clipNames: clipNames
            });
        }
        return _ok({ tracks: tracks });
    } catch (e) {
        return _er(e.toString());
    }
}

/**
 * soloAudioTrack(idx) — Mutes all tracks except the given index
 */
function soloAudioTrack(idx) {
    try {
        var seq = _getActiveSequence();
        if (!seq) return _er("no seq");

        var savedStates = [];
        for (var t = 0; t < seq.audioTracks.numTracks; t++) {
            savedStates.push(seq.audioTracks[t].isMuted());
            seq.audioTracks[t].setMute(t === idx ? 0 : 1);
        }
        return _ok({ solo: idx, originalStates: savedStates });
    } catch (e) {
        return _er(e.toString());
    }
}

/**
 * restoreTrackMutes(json) — Restores previously saved mute states
 */
function restoreTrackMutes(json) {
    try {
        var seq = _getActiveSequence();
        if (!seq) return _er("no seq");

        var states = JSON.parse(json);
        var count = Math.min(states.length, seq.audioTracks.numTracks);
        for (var t = 0; t < count; t++) {
            seq.audioTracks[t].setMute(states[t] ? 1 : 0);
        }
        return _ok({});
    } catch (e) {
        return _er(e.toString());
    }
}

// ── Audio Export ───────────────────────────────────────────────

/**
 * _scanForPresets(folder, depth, results) — Recursively finds .epr files
 */
function _scanForPresets(folder, depth, results) {
    if (depth > 3 || !folder || !folder.exists) return;
    var items = folder.getFiles();
    if (!items) return;

    for (var i = 0; i < items.length; i++) {
        if (items[i] instanceof File && items[i].name.match(/\.epr$/i)) {
            results.push(items[i].fsName);
        } else if (items[i] instanceof Folder && depth < 3) {
            _scanForPresets(items[i], depth + 1, results);
        }
    }
}

/**
 * _pickAudioPreset(list) — Selects the best audio export preset
 */
function _pickAudioPreset(list) {
    var patterns = [/wav/i, /aiff/i, /audio/i, /flac/i, /mp3/i];
    for (var i = 0; i < patterns.length; i++) {
        for (var j = 0; j < list.length; j++) {
            if (patterns[i].test(list[j])) return list[j];
        }
    }
    return list.length > 0 ? list[0] : "";
}

/**
 * findPreset(customPath) — Finds a suitable audio export preset
 */
function findPreset(customPath) {
    if (customPath) {
        var customFile = new File(customPath);
        if (customFile.exists) return customPath;
    }

    var allPresets = [];

    // Search system presets directory
    try {
        var sysPresets = new Folder(app.path + "/MediaIO/systempresets");
        if (sysPresets.exists) _scanForPresets(sysPresets, 0, allPresets);
    } catch (e) { /* */ }

    // Search parent directory presets
    try {
        var appFolder = new Folder(app.path);
        if (appFolder.parent) {
            var altPresets = new Folder(appFolder.parent.fsName + "/MediaIO/systempresets");
            if (altPresets.exists) _scanForPresets(altPresets, 0, allPresets);
        }
    } catch (e) { /* */ }

    return _pickAudioPreset(allPresets);
}

/**
 * exportAudio(outPath, presetPath, workOnly) — Exports sequence audio
 *   workOnly=true  → exports only the work area (In/Out range)
 *   workOnly=false → exports entire sequence
 */
function exportAudio(outPath, presetPath, workOnly) {
    try {
        var seq = _getActiveSequence();
        if (!seq) return _er("אין רצף");

        var preset = findPreset(presetPath);

        // Export mode: 1 = entire sequence, 2 = work area only
        var mode = workOnly ? 2 : 1;
        var attempts = [];

        // Attempt 1: Direct export with preset
        if (preset) {
            try {
                seq.exportAsMediaDirect(outPath, preset, mode);
                var checkFile = new File(outPath);
                if (checkFile.exists && checkFile.length > 100) {
                    return _ok({ path: outPath, method: "direct_preset" });
                }
                attempts.push("preset: empty output");
            } catch (e) {
                attempts.push("preset: " + e.toString().substring(0, 60));
            }
        }

        // Attempt 2: Direct export with default preset
        try {
            seq.exportAsMediaDirect(outPath, "", mode);
            var checkFile2 = new File(outPath);
            if (checkFile2.exists && checkFile2.length > 100) {
                return _ok({ path: outPath, method: "direct_default" });
            }
            attempts.push("default: empty output");
        } catch (e) {
            attempts.push("default: " + e.toString().substring(0, 60));
        }

        // Attempt 3: Via Adobe Media Encoder (async)
        var ameMode = workOnly
            ? app.encoder.ENCODE_WORK_AREA
            : app.encoder.ENCODE_ENTIRE;

        if (preset) {
            try {
                app.encoder.launchEncoder();
                app.encoder.encodeSequence(seq, outPath, preset, ameMode, true);
                return _ok({ path: outPath, method: "ame_preset", async: true });
            } catch (e) {
                attempts.push("ame_preset: " + e.toString().substring(0, 60));
            }
        }

        // Attempt 4: AME with default preset
        try {
            app.encoder.launchEncoder();
            app.encoder.encodeSequence(seq, outPath, "", ameMode, true);
            return _ok({ path: outPath, method: "ame_default", async: true });
        } catch (e) {
            attempts.push("ame_default: " + e.toString().substring(0, 60));
        }

        return _er("ייצוא נכשל:\n" + attempts.join("\n"));
    } catch (e) {
        return _er(e.toString());
    }
}

// ═══════════════════════════════════════════════════════════════
// CAPTION PLACEMENT
// ═══════════════════════════════════════════════════════════════

/**
 * _formatSRTTimestamp(seconds) — Formats seconds as SRT timestamp
 *   e.g. 65.123 → "00:01:05,123"
 */
function _formatSRTTimestamp(sec) {
    sec = Math.max(0, sec);
    var hours   = Math.floor(sec / 3600);
    var minutes = Math.floor((sec % 3600) / 60);
    var seconds = Math.floor(sec % 60);
    var millis  = Math.round((sec - Math.floor(sec)) * 1000);

    // Clamp millis to prevent rounding to 1000
    if (millis >= 1000) { millis = 999; }

    return (hours   < 10 ? "0" : "") + hours   + ":"
         + (minutes < 10 ? "0" : "") + minutes + ":"
         + (seconds < 10 ? "0" : "") + seconds + ","
         + (millis  < 10 ? "00" : millis < 100 ? "0" : "") + millis;
}

/**
 * _buildSRTContent(segments) — Generates SRT string from segment array
 *   Each segment: { start: float, end: float, text: string }
 *   Timestamps must already be in final timeline position (with offset applied)
 */
function _buildSRTContent(segments) {
    var lines = [];
    for (var i = 0; i < segments.length; i++) {
        lines.push(String(i + 1));
        lines.push(
            _formatSRTTimestamp(segments[i].start)
            + " --> "
            + _formatSRTTimestamp(segments[i].end)
        );
        lines.push(segments[i].text);
        lines.push("");  // blank line separator
    }
    return lines.join("\n");
}

/**
 * placeCaptions(segmentsJson, extPath, trackIdx)
 *   — Main caption placement entry point
 *   — Writes SRT, imports to project, inserts on caption track
 *
 *   IMPORTANT: segments must already have correct timeline timestamps
 *   (offset already applied by the caller)
 */
function placeCaptions(segmentsJson, extPath, trackIdx) {
    try {
        var seq = _getActiveSequence();
        if (!seq) return _er("אין רצף פעיל");

        var segments;
        try {
            segments = JSON.parse(segmentsJson);
        } catch (parseErr) {
            return _er("שגיאת פרסור JSON: " + parseErr.toString());
        }

        if (!segments || segments.length === 0) {
            return _er("אין כתוביות להצבה");
        }

        // Build SRT content
        var srtContent = _buildSRTContent(segments);

        // Write SRT to temp file with unique name
        var srtFileName = "subai_cap_" + new Date().getTime() + ".srt";
        var srtPath = Folder.temp.fsName + "/" + srtFileName;
        var srtFile = new File(srtPath);
        srtFile.encoding = "UTF-8";

        if (!srtFile.open("w")) {
            return _er("לא ניתן ליצור קובץ SRT: " + srtPath);
        }

        // Write UTF-8 BOM for better compatibility
        srtFile.write("\uFEFF");
        srtFile.write(srtContent);
        srtFile.close();

        // Verify file was written
        if (!srtFile.exists || srtFile.length < 10) {
            return _er("כתיבת SRT נכשלה");
        }

        // Import SRT into project
        var importSuccess = false;
        try {
            importSuccess = app.project.importFiles(
                [srtPath],
                true,                    // suppressUI
                app.project.rootItem,    // target bin
                false                    // asNumberedStill
            );
        } catch (importErr) {
            return _er("ייבוא SRT נכשל: " + importErr.toString());
        }

        // Find the imported item (search from end — most recently added)
        var importedItem = null;
        var searchName = srtFileName;
        var searchNameNoExt = srtFileName.replace('.srt', '');
        var root = app.project.rootItem;

        for (var j = root.children.numItems - 1; j >= 0; j--) {
            var candidate = root.children[j];
            if (candidate && (candidate.name === searchName
                           || candidate.name === searchNameNoExt)) {
                importedItem = candidate;
                break;
            }
        }

        if (!importedItem) {
            return _er("SRT יובא אך לא נמצא בפרויקט — גרור ידנית מ: " + srtPath);
        }

        // Create Time object for insertion point
        var insertTime = new Time();
        insertTime.seconds = segments[0].start;

        // Attempt insertion methods in order of preference
        // Method 1: insertClip (Premiere auto-detects SRT → caption track)
        try {
            seq.insertClip(importedItem, insertTime);
            return _ok({
                placed: segments.length,
                total:  segments.length,
                method: "caption_track_insert",
                srtPath: srtPath
            });
        } catch (e1) { /* try next method */ }

        // Method 2: overwriteClip
        try {
            seq.overwriteClip(importedItem, insertTime);
            return _ok({
                placed: segments.length,
                total:  segments.length,
                method: "caption_track_overwrite",
                srtPath: srtPath
            });
        } catch (e2) { /* manual placement needed */ }

        // Method 3: SRT imported to project — user drags manually
        return _ok({
            placed: segments.length,
            total:  segments.length,
            method: "srt_in_project",
            srtPath: srtPath,
            note: "SRT יובא לפרויקט — גרור ל-Caption Track ידנית"
        });

    } catch (e) {
        return _er(e.toString());
    }
}

/**
 * importSRT(srtPath, startSec) — Imports an existing SRT file
 */
function importSRT(srtPath, startSec) {
    try {
        var seq = _getActiveSequence();
        if (!seq) return _er("אין רצף");

        var srtFile = new File(srtPath);
        if (!srtFile.exists) return _er("קובץ לא נמצא: " + srtPath);

        app.project.importFiles([srtPath], true, app.project.rootItem, false);

        var importedItem = null;
        var fileName = srtPath.split(/[\/\\]/).pop();
        var root = app.project.rootItem;

        for (var i = root.children.numItems - 1; i >= 0; i--) {
            var item = root.children[i];
            if (item && item.name === fileName) {
                importedItem = item;
                break;
            }
        }

        if (!importedItem) {
            return _ok({ placed: false, note: "SRT יובא לפרויקט" });
        }

        try {
            var startTime = new Time();
            startTime.seconds = parseFloat(startSec) || 0;
            seq.insertClip(importedItem, startTime);
            return _ok({ placed: true, method: "insert" });
        } catch (e) {
            // insertClip failed — SRT is in project at least
        }

        return _ok({ placed: false, note: "SRT יובא — גרור ל-Caption Track ידנית" });
    } catch (e) {
        return _er(e.toString());
    }
}

// ── Project Path ──────────────────────────────────────────────

/**
 * getProjectPath() — Returns the directory containing the .prproj file
 */
function getProjectPath() {
    try {
        var proj = app.project;
        if (!proj || !proj.path) {
            return _er("פרויקט לא נשמר — שמור את הפרויקט תחילה");
        }

        var projFile = new File(proj.path);
        if (!projFile.parent || !projFile.parent.exists) {
            return _er("תיקיית הפרויקט לא נמצאה");
        }

        return _ok({ path: projFile.parent.fsName });
    } catch (e) {
        return _er(e.toString());
    }
}

/**
 * saveSRTNextToProject(srtContent, fileName) — Saves SRT file next to .prproj
 */
function saveSRTNextToProject(srtContent, fileName) {
    try {
        var proj = app.project;
        if (!proj || !proj.path) return _er("פרויקט לא נשמר");

        var projFile = new File(proj.path);
        if (!projFile.parent || !projFile.parent.exists) return _er("תיקייה לא נמצאה");

        var outPath = projFile.parent.fsName + "/" + fileName;
        var outFile = new File(outPath);
        outFile.encoding = "UTF-8";

        if (!outFile.open("w")) return _er("לא ניתן לכתוב: " + outPath);

        outFile.write("\uFEFF");
        outFile.write(srtContent);
        outFile.close();

        return _ok({ path: outPath });
    } catch (e) {
        return _er(e.toString());
    }
}
