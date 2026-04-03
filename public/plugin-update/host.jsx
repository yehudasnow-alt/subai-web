/**
 * SubAI — Premiere Pro ExtendScript (host.jsx) v4.0
 * Called from index.html via evalScript()
 */

// ── Get active sequence info ──
function getSeq() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ok:false,e:"No active sequence"});
    var fps = seq.getSettings().videoFrameRate.ticks;
    var ticksPerSec = 254016000000;
    var fpsNum = ticksPerSec / fps;
    var dur = seq.end / ticksPerSec;
    var io = seq.getInPoint();
    var oo = seq.getOutPoint();
    var inSec = io / ticksPerSec;
    var outSec = oo / ticksPerSec;
    var hasWA = (outSec - inSec) > 0.3 && outSec < dur + 1;
    if (!hasWA) { inSec = 0; outSec = dur; hasWA = dur > 0.5; }
    return JSON.stringify({ok:true,name:seq.name,dur:dur,i:inSec,o:outSec,hasWA:hasWA,fps:fpsNum});
  } catch(e) { return JSON.stringify({ok:false,e:e.toString()}); }
}

// ── Get In/Out points (lightweight poll) ──
function getInOut() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ok:false});
    var ticksPerSec = 254016000000;
    var dur = seq.end / ticksPerSec;
    var io = seq.getInPoint();
    var oo = seq.getOutPoint();
    var inSec = io / ticksPerSec;
    var outSec = oo / ticksPerSec;
    var hasWA = (outSec - inSec) > 0.3 && outSec < dur + 1;
    if (!hasWA) { inSec = 0; outSec = dur; hasWA = dur > 0.5; }
    return JSON.stringify({ok:true,i:inSec,o:outSec,hasWA:hasWA,dur:dur});
  } catch(e) { return JSON.stringify({ok:false}); }
}

// ── Get project folder path (for saving SRT) ──
function getProjectPath() {
  try {
    var proj = app.project;
    if (!proj || !proj.path || proj.path === "") return JSON.stringify({ok:false,e:"Project not saved"});
    var f = new File(proj.path);
    return JSON.stringify({ok:true, path:f.parent.fsName});
  } catch(e) { return JSON.stringify({ok:false, e:e.toString()}); }
}

// ── Export audio via AME or direct ──
function exportAudio(outPath, preset, useAME) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ok:false,e:"No sequence"});
    // Use Premiere's built-in export
    seq.exportAsMediaDirect(outPath, "C:\\Program Files\\Adobe\\Adobe Premiere Pro 2025\\MediaIO\\systempresets\\58534150_4D6F6E6F.epr", 0);
    return JSON.stringify({ok:true, async:false});
  } catch(e) {
    // Fallback: try AME
    try {
      var encoder = app.encoder;
      if (encoder) {
        encoder.launchEncoder();
        var seqPath = seq.projectItem.treePath;
        encoder.encodeSequence(seq, outPath, "C:\\Program Files\\Adobe\\Adobe Premiere Pro 2025\\MediaIO\\systempresets\\58534150_4D6F6E6F.epr", 0, 1);
        return JSON.stringify({ok:true, async:true});
      }
    } catch(e2) {}
    return JSON.stringify({ok:false, e:e.toString()});
  }
}

// ── Get audio tracks ──
function getAudioTracks() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ok:false});
    var tracks = [];
    for (var i = 0; i < seq.audioTracks.numTracks; i++) {
      var t = seq.audioTracks[i];
      if (t.clips.numItems > 0) {
        tracks.push({index:i, name:t.name || ("Audio " + (i+1))});
      }
    }
    return JSON.stringify({ok:true, tracks:tracks});
  } catch(e) { return JSON.stringify({ok:false, e:e.toString()}); }
}

// ── Solo audio track (mute all others) ──
function soloAudioTrack(trackIndex) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ok:false});
    var states = [];
    for (var i = 0; i < seq.audioTracks.numTracks; i++) {
      states.push(seq.audioTracks[i].isMuted());
      if (i !== trackIndex) seq.audioTracks[i].setMute(1);
      else seq.audioTracks[i].setMute(0);
    }
    return JSON.stringify({ok:true, originalStates:states});
  } catch(e) { return JSON.stringify({ok:false, e:e.toString()}); }
}

// ── Restore track mute states ──
function restoreTrackMutes(statesJson) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ok:false});
    var states = eval('(' + statesJson + ')');
    for (var i = 0; i < states.length && i < seq.audioTracks.numTracks; i++) {
      seq.audioTracks[i].setMute(states[i] ? 1 : 0);
    }
    return JSON.stringify({ok:true});
  } catch(e) { return JSON.stringify({ok:false}); }
}

// ── Place captions as MOGRT or text clips on timeline ──
function placeCaptions(segsJson, extPath, trackIdx) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return JSON.stringify({ok:false, e:"No sequence"});
    var segs = eval('(' + segsJson + ')');
    if (!segs || segs.length === 0) return JSON.stringify({ok:false, e:"No segments"});
    
    var ticksPerSec = 254016000000;
    
    // Try MOGRT approach first
    var mogrtPath = extPath + "/mogrt/SubAI_Caption.mogrt";
    var mogrtFile = new File(mogrtPath);
    
    if (mogrtFile.exists) {
      // Use MOGRT
      var vidTrackIdx = (trackIdx >= 0) ? trackIdx : seq.videoTracks.numTracks - 1;
      if (vidTrackIdx < 0) vidTrackIdx = 0;
      var vidTrack = seq.videoTracks[vidTrackIdx];
      
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        var startTicks = Math.round(s.start * ticksPerSec).toString();
        var endTicks = Math.round(s.end * ticksPerSec).toString();
        try {
          var clip = seq.importMGT(mogrtPath, startTicks, vidTrackIdx, vidTrackIdx);
          if (clip) {
            clip.end = endTicks;
            // Set text property
            var components = clip.getMGTComponent();
            if (components) {
              components.properties[0].setValue(s.text);
            }
          }
        } catch(me) {}
      }
      return JSON.stringify({ok:true, method:"mogrt", count:segs.length});
    }
    
    // Fallback: use SRT import method
    return JSON.stringify({ok:false, method:"srt_project"});
    
  } catch(e) { return JSON.stringify({ok:false, e:e.toString()}); }
}

// ── Import SRT file into project ──
function importSRT(srtPath, offsetSec) {
  try {
    var proj = app.project;
    if (!proj) return JSON.stringify({ok:false});
    
    // Import SRT as caption file
    var fileArr = [srtPath];
    var suppressUI = true;
    proj.importFiles(fileArr, suppressUI);
    
    // Try to add to active sequence
    try {
      var seq = app.project.activeSequence;
      if (seq) {
        // Find the imported item
        var rootItem = proj.rootItem;
        for (var i = rootItem.children.numItems - 1; i >= 0; i--) {
          var item = rootItem.children[i];
          if (item.name.indexOf("SubAI") >= 0 || item.name.indexOf(".srt") >= 0) {
            // Insert at beginning of first caption track or video track
            var ticksPerSec = 254016000000;
            var offset = Math.round((offsetSec || 0) * ticksPerSec).toString();
            seq.insertClip(item, offset, seq.videoTracks.numTracks - 1, seq.videoTracks.numTracks - 1);
            break;
          }
        }
      }
    } catch(se) {}
    
    return JSON.stringify({ok:true});
  } catch(e) { return JSON.stringify({ok:false, e:e.toString()}); }
}
