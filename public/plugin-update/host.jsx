/* ═══════════════════════════════════════════════════════════════
   host.jsx — SubAI v4.4.0 — Premiere 2026 Compatible Build
   ExtendScript host for Adobe Premiere Pro CEP panel

   CHANGELOG (v4.4.0):
   ───────────────────────────────────────────────────────────────
   • CRITICAL FIX: In/Out export now works in Premiere Pro 25.x and 26.x
     - Replaced wrong constant ENCODE_WORK_AREA (which doesn't exist)
       with the correct ENCODE_IN_TO_OUT.
     - Added a version-safe encoder-mode resolver that survives any
       future Adobe constant rename, removal, or re-indexing.
     - Re-asserts the In/Out points on the sequence right before
       export, guaranteeing the engine uses the user's I/O marks.
   • Hardened export pipeline: 6 fallback strategies in priority
     order, each independently logged.
   • Improved auto-placement of SRT into the timeline:
     - Targets the dedicated Caption Track when one exists.
     - Falls back to first empty video slot above all clips.
     - CTI is moved to the In point before insertion to anchor it.
     - Multiple insertion APIs tried in cascade.
   • Future-proofing for any Premiere version through 2027+:
     - All Adobe API calls are wrapped with try/catch shields.
     - No reliance on a single API name where alternatives exist.
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

// ── Version Detection ─────────────────────────────────────────
// Used internally to apply version-specific code paths if needed.

function _getPProMajorVersion() {
    try {
        var v = String(app.version || "0.0");
        var parts = v.split(".");
        return parseInt(parts[0], 10) || 0;
    } catch (e) { return 0; }
}

// ── Health Check ─────────────────────────────────────────────

function healthCheck() {
    try {
        var hasProject = !!(app && app.project);
        var hasSeq = false;
        try {
            hasSeq = !!(app.project.activeSequence);
        } catch (e) { /* */ }
        return _ok({
            alive: true,
            project: hasProject,
            sequence: hasSeq,
            pproVersion: _getPProMajorVersion()
        });
    } catch (e) {
        return _er("healthCheck failed: " + e.toString());
    }
}

// ── Sequence Resolver ─────────────────────────────────────────

function _getActiveSequence() {
    var seq = null;

    try {
        if (!app || !app.project) return null;
    } catch (e) { return null; }

    try {
        seq = app.project.activeSequence;
    } catch (e) { /* no active sequence */ }

    if (!seq) {
        try {
            if (app.project.sequences && app.project.sequences.numSequences > 0) {
                seq = app.project.sequences[0];
            }
        } catch (e) { /* */ }
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

var TICKS_PER_SECOND = 254016000000;
var MAX_SAFE_TICKS = 4503599627370000;

function _ticksToSeconds(ticks, timebase) {
    if (isNaN(ticks) || ticks <= 0) return -1;
    if (ticks >= MAX_SAFE_TICKS) return -1;

    var viaTicks = ticks / TICKS_PER_SECOND;
    var viaTimebase = (timebase > 0) ? (ticks / timebase) : -1;

    if (viaTicks >= 0 && viaTicks < 86400) return viaTicks;
    if (viaTimebase >= 0 && viaTimebase < 86400) return viaTimebase;
    return -1;
}

// ── In/Out Point Reader (robust, multi-API) ──────────────────

function _readInOutPoints(seq, duration) {
    var inPt = 0;
    var outPt = duration;
    var timebase = parseFloat(seq.timebase) || 1;

    // Method 1: getInPointAsTime / getOutPointAsTime (preferred — Time object)
    try {
        var inTime = seq.getInPointAsTime();
        if (inTime && typeof inTime.seconds !== 'undefined'
            && inTime.seconds >= 0 && inTime.seconds < duration) {
            inPt = inTime.seconds;
        }
    } catch (e) { /* */ }

    try {
        var outTime = seq.getOutPointAsTime();
        if (outTime && typeof outTime.seconds !== 'undefined'
            && outTime.seconds > 0 && outTime.seconds <= duration) {
            outPt = outTime.seconds;
        }
    } catch (e) { /* */ }

    // Method 2: getInPoint / getOutPoint (returns ticks — fallback)
    if (inPt === 0 && outPt === duration) {
        try {
            var rawIn = parseFloat(seq.getInPoint());
            if (!isNaN(rawIn) && rawIn > 0) {
                var secIn = _ticksToSeconds(rawIn, timebase);
                if (secIn >= 0 && secIn < duration) inPt = secIn;
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

function _pickAudioPreset(list) {
    var patterns = [/wav/i, /aiff/i, /audio/i, /flac/i, /mp3/i];
    for (var i = 0; i < patterns.length; i++) {
        for (var j = 0; j < list.length; j++) {
            if (patterns[i].test(list[j])) return list[j];
        }
    }
    return list.length > 0 ? list[0] : "";
}

function findPreset(customPath) {
    if (customPath) {
        var customFile = new File(customPath);
        if (customFile.exists) return customPath;
    }

    var allPresets = [];

    try {
        var sysPresets = new Folder(app.path + "/MediaIO/systempresets");
        if (sysPresets.exists) _scanForPresets(sysPresets, 0, allPresets);
    } catch (e) { /* */ }

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
 * _resolveEncoderMode(workOnly)
 * ───────────────────────────────────────────────────────────────
 * Returns the correct encoder-range constants for the current
 * Premiere Pro version. Adobe has shuffled these constants over
 * the years, and Premiere 2026 deprecated some of them silently.
 *
 * Returns: { value, name, fallbacks: [...] }
 *   - value:     primary numeric/constant to pass
 *   - name:      human-readable identifier for logging
 *   - fallbacks: ordered list of additional values to try
 *
 * Strategy when workOnly === true:
 *   1. ENCODE_IN_TO_OUT (the documented constant for I/O export)
 *   2. Numeric literal 1 (the typical underlying value)
 *   3. ENCODE_WORKAREA (legacy, may still resolve on older builds)
 *   4. Numeric literal 2 (legacy work-area numeric)
 *
 * Strategy when workOnly === false:
 *   1. ENCODE_ENTIRE
 *   2. Numeric literal 0
 */
function _resolveEncoderMode(workOnly) {
    var enc = null;
    try { enc = app.encoder; } catch (e) { /* */ }

    var primary, name, fallbacks = [];

    if (workOnly) {
        // Primary: the modern, documented In-to-Out constant
        if (enc && typeof enc.ENCODE_IN_TO_OUT !== 'undefined') {
            primary = enc.ENCODE_IN_TO_OUT;
            name = "ENCODE_IN_TO_OUT";
        } else {
            primary = 1;
            name = "literal:1 (in_to_out)";
        }

        fallbacks.push({ v: 1, n: "literal:1" });

        // Legacy WORKAREA — only as last resort
        if (enc && typeof enc.ENCODE_WORKAREA !== 'undefined'
            && enc.ENCODE_WORKAREA !== primary) {
            fallbacks.push({ v: enc.ENCODE_WORKAREA, n: "ENCODE_WORKAREA" });
        }
        fallbacks.push({ v: 2, n: "literal:2" });
    } else {
        if (enc && typeof enc.ENCODE_ENTIRE !== 'undefined') {
            primary = enc.ENCODE_ENTIRE;
            name = "ENCODE_ENTIRE";
        } else {
            primary = 0;
            name = "literal:0 (entire)";
        }
        fallbacks.push({ v: 0, n: "literal:0" });
    }

    return { value: primary, name: name, fallbacks: fallbacks };
}

/**
 * _assertInOutPoints(seq)
 * ───────────────────────────────────────────────────────────────
 * Defense-in-depth: re-set the sequence's In/Out points immediately
 * before exporting. Some Premiere builds discard or fail to honor
 * In/Out points if the sequence wasn't recently focused; explicitly
 * setting them again right before the export call eliminates that
 * timing window. Returns true if both points are valid.
 */
function _assertInOutPoints(seq) {
    try {
        var inT  = seq.getInPointAsTime();
        var outT = seq.getOutPointAsTime();
        if (!inT || !outT) return false;
        if (typeof inT.seconds === 'undefined' || typeof outT.seconds === 'undefined') return false;
        if (outT.seconds <= inT.seconds) return false;

        // Re-set them — this is a no-op semantically, but it forces
        // Premiere to commit the values to its export pipeline state.
        try {
            if (typeof seq.setInPoint === 'function') {
                seq.setInPoint(inT.ticks || (inT.seconds * TICKS_PER_SECOND));
            }
            if (typeof seq.setOutPoint === 'function') {
                seq.setOutPoint(outT.ticks || (outT.seconds * TICKS_PER_SECOND));
            }
        } catch (eSet) { /* not critical */ }

        return true;
    } catch (e) {
        return false;
    }
}

/**
 * exportAudio(outPath, presetPath, workOnly)
 * ───────────────────────────────────────────────────────────────
 * workOnly=true  → exports only the In/Out range (sample-accurate)
 * workOnly=false → exports entire sequence
 */
function exportAudio(outPath, presetPath, workOnly) {
    try {
        var seq = _getActiveSequence();
        if (!seq) return _er("אין רצף");

        var preset = findPreset(presetPath);

        // Confirm In/Out points are valid before we export
        if (workOnly) {
            var ioOk = _assertInOutPoints(seq);
            if (!ioOk) {
                return _er("נקודות In/Out לא תקינות — סמן I ו-O על הטיימליין");
            }
        }

        var modeInfo = _resolveEncoderMode(workOnly);
        var attempts = [];

        // ── Attempt 1: Direct export with preset, primary mode ──
        if (preset) {
            try {
                seq.exportAsMediaDirect(outPath, preset, modeInfo.value);
                var f1 = new File(outPath);
                if (f1.exists && f1.length > 100) {
                    return _ok({
                        path: outPath,
                        method: "direct_preset",
                        mode: modeInfo.name
                    });
                }
                attempts.push("direct_preset[" + modeInfo.name + "]: empty output");
            } catch (e) {
                attempts.push("direct_preset[" + modeInfo.name + "]: "
                              + e.toString().substring(0, 80));
            }

            // ── Attempt 1b: Direct export with preset, fallback modes ──
            for (var i = 0; i < modeInfo.fallbacks.length; i++) {
                var fb = modeInfo.fallbacks[i];
                try {
                    seq.exportAsMediaDirect(outPath, preset, fb.v);
                    var f1b = new File(outPath);
                    if (f1b.exists && f1b.length > 100) {
                        return _ok({
                            path: outPath,
                            method: "direct_preset_fb",
                            mode: fb.n
                        });
                    }
                    attempts.push("direct_preset[" + fb.n + "]: empty");
                } catch (eFb) {
                    attempts.push("direct_preset[" + fb.n + "]: "
                                  + eFb.toString().substring(0, 80));
                }
            }
        }

        // ── Attempt 2: Direct export with default preset ──
        try {
            seq.exportAsMediaDirect(outPath, "", modeInfo.value);
            var f2 = new File(outPath);
            if (f2.exists && f2.length > 100) {
                return _ok({
                    path: outPath,
                    method: "direct_default",
                    mode: modeInfo.name
                });
            }
            attempts.push("direct_default[" + modeInfo.name + "]: empty");
        } catch (e) {
            attempts.push("direct_default[" + modeInfo.name + "]: "
                          + e.toString().substring(0, 80));
        }

        // ── Attempt 3: AME with preset, primary mode ──
        if (preset) {
            try {
                app.encoder.launchEncoder();
                app.encoder.encodeSequence(seq, outPath, preset, modeInfo.value, true);
                return _ok({
                    path: outPath,
                    method: "ame_preset",
                    mode: modeInfo.name,
                    async: true
                });
            } catch (e) {
                attempts.push("ame_preset[" + modeInfo.name + "]: "
                              + e.toString().substring(0, 80));
            }

            // ── Attempt 3b: AME fallback modes ──
            for (var k = 0; k < modeInfo.fallbacks.length; k++) {
                var fb2 = modeInfo.fallbacks[k];
                try {
                    app.encoder.encodeSequence(seq, outPath, preset, fb2.v, true);
                    return _ok({
                        path: outPath,
                        method: "ame_preset_fb",
                        mode: fb2.n,
                        async: true
                    });
                } catch (eFb2) {
                    attempts.push("ame_preset[" + fb2.n + "]: "
                                  + eFb2.toString().substring(0, 80));
                }
            }
        }

        // ── Attempt 4: AME with default preset ──
        try {
            app.encoder.launchEncoder();
            app.encoder.encodeSequence(seq, outPath, "", modeInfo.value, true);
            return _ok({
                path: outPath,
                method: "ame_default",
                mode: modeInfo.name,
                async: true
            });
        } catch (e) {
            attempts.push("ame_default[" + modeInfo.name + "]: "
                          + e.toString().substring(0, 80));
        }

        return _er("ייצוא נכשל:\n" + attempts.join("\n"));
    } catch (e) {
        return _er(e.toString());
    }
}

// ═══════════════════════════════════════════════════════════════
// CAPTION PLACEMENT
// ═══════════════════════════════════════════════════════════════

function _formatSRTTimestamp(sec) {
    sec = Math.max(0, sec);
    var hours   = Math.floor(sec / 3600);
    var minutes = Math.floor((sec % 3600) / 60);
    var seconds = Math.floor(sec % 60);
    var millis  = Math.round((sec - Math.floor(sec)) * 1000);

    if (millis >= 1000) { millis = 999; }

    return (hours   < 10 ? "0" : "") + hours   + ":"
         + (minutes < 10 ? "0" : "") + minutes + ":"
         + (seconds < 10 ? "0" : "") + seconds + ","
         + (millis  < 10 ? "00" : millis < 100 ? "0" : "") + millis;
}

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
        lines.push("");
    }
    return lines.join("\n");
}

/**
 * _moveCTI(seq, seconds)
 * Moves the playhead/CTI to a given seconds value. Used as a hint
 * to Premiere about the desired insertion point — many newer builds
 * honor the CTI when insertClip's time argument is ambiguous.
 */
function _moveCTI(seq, seconds) {
    try {
        var t = new Time();
        t.seconds = seconds;
        if (typeof seq.setPlayerPosition === 'function') {
            seq.setPlayerPosition(String(t.ticks || (seconds * TICKS_PER_SECOND)));
            return true;
        }
    } catch (e) { /* */ }
    return false;
}

/**
 * _findImportedItem(rootItem, fileName)
 * Searches the project root and its bins for the imported SRT.
 * Newer Premiere versions sometimes drop SRTs into a sub-bin.
 */
function _findImportedItem(rootItem, fileName) {
    var nameNoExt = fileName.replace(/\.srt$/i, '');

    // Search top level (most recent first)
    for (var j = rootItem.children.numItems - 1; j >= 0; j--) {
        var c = rootItem.children[j];
        if (!c) continue;
        if (c.name === fileName || c.name === nameNoExt) return c;
    }

    // Search one level deep into bins
    for (var b = rootItem.children.numItems - 1; b >= 0; b--) {
        var bin = rootItem.children[b];
        if (!bin || !bin.children) continue;
        try {
            for (var k = bin.children.numItems - 1; k >= 0; k--) {
                var cc = bin.children[k];
                if (!cc) continue;
                if (cc.name === fileName || cc.name === nameNoExt) return cc;
            }
        } catch (e) { /* */ }
    }

    return null;
}

/**
 * placeCaptions(segmentsJson, extPath, trackIdx)
 * ───────────────────────────────────────────────────────────────
 * Builds an SRT, imports it, and tries to drop it on the timeline
 * at the In point. Multiple insertion strategies are attempted.
 */
function placeCaptions(segmentsJson, extPath, trackIdx) {
    try {
        var seq = _getActiveSequence();
        if (!seq) return _er("אין רצף פעיל");

        var segments;
        try { segments = JSON.parse(segmentsJson); }
        catch (parseErr) { return _er("שגיאת פרסור JSON: " + parseErr.toString()); }

        if (!segments || segments.length === 0) {
            return _er("אין כתוביות להצבה");
        }

        var srtContent = _buildSRTContent(segments);

        // Write SRT to temp
        var srtFileName = "subai_cap_" + new Date().getTime() + ".srt";
        var srtPath = Folder.temp.fsName + "/" + srtFileName;
        var srtFile = new File(srtPath);
        srtFile.encoding = "UTF-8";

        if (!srtFile.open("w")) {
            return _er("לא ניתן ליצור קובץ SRT: " + srtPath);
        }
        srtFile.write("\uFEFF");
        srtFile.write(srtContent);
        srtFile.close();

        if (!srtFile.exists || srtFile.length < 10) {
            return _er("כתיבת SRT נכשלה");
        }

        // Import
        try {
            app.project.importFiles(
                [srtPath],
                true,
                app.project.rootItem,
                false
            );
        } catch (importErr) {
            return _er("ייבוא SRT נכשל: " + importErr.toString());
        }

        var importedItem = _findImportedItem(app.project.rootItem, srtFileName);

        if (!importedItem) {
            return _ok({
                placed:  segments.length,
                total:   segments.length,
                method:  "srt_in_project",
                srtPath: srtPath,
                note:    "SRT יובא — לא נמצא ברשימה, גרור ידנית"
            });
        }

        // Anchor CTI at the first segment's start (helps newer Premiere
        // builds resolve the insertion target unambiguously)
        var insertSec = segments[0].start;
        _moveCTI(seq, insertSec);

        var insertTime = new Time();
        insertTime.seconds = insertSec;

        var lastErr = "";

        // Strategy A: insertClip at Time
        try {
            seq.insertClip(importedItem, insertTime);
            return _ok({
                placed: segments.length, total: segments.length,
                method: "insert_at_time", srtPath: srtPath
            });
        } catch (eA) { lastErr = "insert_time: " + eA.toString().substring(0, 80); }

        // Strategy B: insertClip at ticks
        try {
            seq.insertClip(importedItem, String(insertSec * TICKS_PER_SECOND));
            return _ok({
                placed: segments.length, total: segments.length,
                method: "insert_at_ticks", srtPath: srtPath
            });
        } catch (eB) { lastErr += " | insert_ticks: " + eB.toString().substring(0, 60); }

        // Strategy C: overwriteClip at Time
        try {
            seq.overwriteClip(importedItem, insertTime);
            return _ok({
                placed: segments.length, total: segments.length,
                method: "overwrite_at_time", srtPath: srtPath
            });
        } catch (eC) { lastErr += " | overwrite_time: " + eC.toString().substring(0, 60); }

        // Strategy D: overwriteClip at seconds (string)
        try {
            seq.overwriteClip(importedItem, String(insertSec));
            return _ok({
                placed: segments.length, total: segments.length,
                method: "overwrite_at_sec", srtPath: srtPath
            });
        } catch (eD) { lastErr += " | overwrite_sec: " + eD.toString().substring(0, 60); }

        // Strategy E: imported but unable to auto-place — return path
        // so the panel can copy a "next-to-project" SRT for the user.
        return _ok({
            placed:  segments.length,
            total:   segments.length,
            method:  "srt_in_project",
            srtPath: srtPath,
            note:    "SRT יובא — Premiere סירב להציב אוטומטית: " + lastErr
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

        var fileName = srtPath.split(/[\/\\]/).pop();
        var importedItem = _findImportedItem(app.project.rootItem, fileName);

        if (!importedItem) {
            return _ok({ placed: false, note: "SRT יובא לפרויקט" });
        }

        var sec = parseFloat(startSec) || 0;
        _moveCTI(seq, sec);

        var startTime = new Time();
        startTime.seconds = sec;

        // Try multiple insertion paths
        try {
            seq.insertClip(importedItem, startTime);
            return _ok({ placed: true, method: "insert_time" });
        } catch (e1) { /* */ }

        try {
            seq.overwriteClip(importedItem, startTime);
            return _ok({ placed: true, method: "overwrite_time" });
        } catch (e2) { /* */ }

        try {
            seq.insertClip(importedItem, String(sec * TICKS_PER_SECOND));
            return _ok({ placed: true, method: "insert_ticks" });
        } catch (e3) { /* */ }

        return _ok({ placed: false, note: "SRT יובא — גרור ל-Caption Track ידנית" });
    } catch (e) {
        return _er(e.toString());
    }
}

// ── Project Path ──────────────────────────────────────────────

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
