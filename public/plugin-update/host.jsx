/* host.jsx — SubAI v4.0 — Maximum Timeline Caption Placement */

function _ok(o){var r={ok:true};for(var k in o)r[k]=o[k];return JSON.stringify(r);}
function _er(m){return JSON.stringify({ok:false,e:String(m)});}
function _seq(){var s=null;try{s=app.project.activeSequence;}catch(e){}
  if(!s){try{if(app.project.sequences&&app.project.sequences.numSequences>0)s=app.project.sequences[0];}catch(e){}}return s;}

function getSeq(){try{
  var s=_seq();if(!s)return _er("אין רצף פעיל");
  var tb=parseFloat(s.timebase)||1,dur=parseFloat(s.end)/tb;
  if(isNaN(dur)||dur<=0)dur=0;
  var i=0,o=dur,BIG=4503599627370000;
  try{var t=s.getInPointAsTime();if(t&&typeof t.seconds!=='undefined'&&t.seconds>=0&&t.seconds<dur)i=t.seconds;}catch(e){}
  try{var t=s.getOutPointAsTime();if(t&&typeof t.seconds!=='undefined'&&t.seconds>0&&t.seconds<=dur)o=t.seconds;}catch(e){}
  if(i===0&&o===dur){
    try{var r=parseFloat(s.getInPoint());if(!isNaN(r)&&r>0&&r<BIG){var v=r/254016000000;i=(v<dur)?v:r/tb;if(i>=dur)i=0;}}catch(e){}
    try{var r=parseFloat(s.getOutPoint());if(!isNaN(r)&&r>0&&r<BIG){var v=r/254016000000;o=(v<=dur*1.1)?v:r/tb;if(o>dur)o=dur;}}catch(e){}
  }
  if(o<=i){i=0;o=dur;}
  var fps=25;try{var st=s.getSettings();if(st.videoFrameRate&&st.videoFrameRate.seconds>0)fps=Math.round(1/st.videoFrameRate.seconds);}catch(e){}
  var hasWA=(o-i)>0.5&&(i>0.5||(dur-o)>0.5);
  return _ok({name:s.name||"רצף",dur:Math.round(dur*1000)/1000,fps:fps,i:Math.round(i*1000)/1000,o:Math.round(o*1000)/1000,hasWA:hasWA});
}catch(e){return _er(e.toString());}}

function getInOut(){try{
  var s=_seq();if(!s)return _er("no seq");
  var tb=parseFloat(s.timebase)||1,dur=parseFloat(s.end)/tb;
  var i=0,o=dur,BIG=4503599627370000;
  try{var t=s.getInPointAsTime();if(t&&t.seconds>=0&&t.seconds<dur)i=t.seconds;}catch(e){}
  try{var t=s.getOutPointAsTime();if(t&&t.seconds>0&&t.seconds<=dur)o=t.seconds;}catch(e){}
  if(i===0&&o===dur){
    try{var r=parseFloat(s.getInPoint());if(r>0&&r<BIG){var v=r/254016000000;i=(v<dur)?v:r/tb;if(i>=dur)i=0;}}catch(e){}
    try{var r=parseFloat(s.getOutPoint());if(r>0&&r<BIG){var v=r/254016000000;o=(v<=dur*1.1)?v:r/tb;if(o>dur)o=dur;}}catch(e){}
  }
  if(o<=i){i=0;o=dur;}
  var hasWA=(o-i)>0.5&&(i>0.5||(dur-o)>0.5);
  return _ok({i:Math.round(i*1000)/1000,o:Math.round(o*1000)/1000,hasWA:hasWA,dur:Math.round(dur*1000)/1000});
}catch(e){return _er(e.toString());}}

function getAudioTracks(){try{
  var s=_seq();if(!s)return _er("no seq");var tracks=[];
  for(var t=0;t<s.audioTracks.numTracks;t++){var track=s.audioTracks[t];var cn=0,names=[];
    try{cn=track.clips.numItems;for(var c=0;c<Math.min(cn,3);c++){try{names.push(track.clips[c].name);}catch(e){}}}catch(e){}
    tracks.push({index:t,name:track.name||("A"+(t+1)),muted:track.isMuted(),clipCount:cn,clipNames:names});}
  return _ok({tracks:tracks});
}catch(e){return _er(e.toString());}}

function soloAudioTrack(idx){try{
  var s=_seq();if(!s)return _er("no seq");var st=[];
  for(var t=0;t<s.audioTracks.numTracks;t++){st.push(s.audioTracks[t].isMuted());s.audioTracks[t].setMute(t===idx?0:1);}
  return _ok({solo:idx,originalStates:st});
}catch(e){return _er(e.toString());}}

function restoreTrackMutes(json){try{
  var s=_seq();if(!s)return _er("no seq");var st=JSON.parse(json);
  for(var t=0;t<Math.min(st.length,s.audioTracks.numTracks);t++){s.audioTracks[t].setMute(st[t]?1:0);}
  return _ok({});
}catch(e){return _er(e.toString());}}

/* ── Preset & Export ── */
function _scanEPR(f,d,r){if(d>3||!f||!f.exists)return;var it=f.getFiles();if(!it)return;
  for(var i=0;i<it.length;i++){if(it[i] instanceof File&&it[i].name.match(/\.epr$/i))r.push(it[i].fsName);
  else if(it[i] instanceof Folder&&d<3)_scanEPR(it[i],d+1,r);}}
function _pick(l){var p=[/wav/i,/aiff/i,/audio/i,/flac/i,/mp3/i];
  for(var i=0;i<p.length;i++)for(var j=0;j<l.length;j++)if(p[i].test(l[j]))return l[j];return l.length>0?l[0]:"";}
function findPreset(c){if(c){var f=new File(c);if(f.exists)return c;}var a=[];
  try{var sp=new Folder(app.path+"/MediaIO/systempresets");if(sp.exists)_scanEPR(sp,0,a);}catch(e){}
  try{var b=new Folder(app.path);if(b.parent){var sp2=new Folder(b.parent.fsName+"/MediaIO/systempresets");if(sp2.exists)_scanEPR(sp2,0,a);}}catch(e){}
  return _pick(a);}

function exportAudio(outPath,presetPath,workOnly){try{
  var s=_seq();if(!s)return _er("אין רצף");var pr=findPreset(presetPath);var m=workOnly?2:1;var tried=[];
  if(pr){try{s.exportAsMediaDirect(outPath,pr,m);var f=new File(outPath);if(f.exists&&f.length>100)return _ok({path:outPath,m:"direct"});tried.push("d:empty");}catch(e){tried.push("d:"+e.toString().substring(0,40));}}
  try{s.exportAsMediaDirect(outPath,"",m);var f=new File(outPath);if(f.exists&&f.length>100)return _ok({path:outPath,m:"default"});tried.push("def:empty");}catch(e){tried.push("def:"+e.toString().substring(0,40));}
  if(pr){try{app.encoder.launchEncoder();app.encoder.encodeSequence(s,outPath,pr,workOnly?app.encoder.ENCODE_WORK_AREA:app.encoder.ENCODE_ENTIRE,true);return _ok({path:outPath,m:"ame",async:true});}catch(e){tried.push("ame:"+e.toString().substring(0,40));}}
  try{app.encoder.launchEncoder();app.encoder.encodeSequence(s,outPath,"",workOnly?app.encoder.ENCODE_WORK_AREA:app.encoder.ENCODE_ENTIRE,true);return _ok({path:outPath,m:"ame_d",async:true});}catch(e){tried.push("ame_d:"+e.toString().substring(0,40));}
  return _er("ייצוא נכשל\n"+tried.join("\n"));
}catch(e){return _er(e.toString());}}

/* ═══════════════════════════════════════════
   CAPTION PLACEMENT — SRT direct to Caption Track (Premiere 2025)
   ═══════════════════════════════════════════ */

function _ts(sec){sec=Math.max(0,sec);var h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),sc=Math.floor(sec%60),ms=Math.round((sec-Math.floor(sec))*1000);
  return(h<10?"0":"")+h+":"+(m<10?"0":"")+m+":"+(sc<10?"0":"")+sc+","+(ms<10?"00":ms<100?"0":"")+ms;}

function placeCaptions(segmentsJson, extPath, trackIdx) {
    try {
        var s = _seq();
        if (!s) return _er("אין רצף");
        var segments = JSON.parse(segmentsJson);
        if (!segments || segments.length === 0) return _er("אין כתוביות");

        // Build SRT content from segments
        var srtContent = "";
        for (var i = 0; i < segments.length; i++) {
            srtContent += (i + 1) + "\n";
            srtContent += _ts(segments[i].start) + " --> " + _ts(segments[i].end) + "\n";
            srtContent += segments[i].text + "\n\n";
        }

        // Write SRT file
        var srtPath = Folder.temp.fsName + "/subai_cap_" + Date.now() + ".srt";
        var f = new File(srtPath);
        f.encoding = "UTF-8";
        f.open("w");
        f.write(srtContent);
        f.close();

        // Import SRT to project
        app.project.importFiles([srtPath], true, app.project.rootItem, false);

        // Find the imported item (search from end — most recent)
        var item = null;
        var fname = srtPath.split(/[\/\\]/).pop();
        var root = app.project.rootItem;
        for (var j = root.children.numItems - 1; j >= 0; j--) {
            var it = root.children[j];
            if (it && (it.name === fname || it.name === fname.replace('.srt', ''))) {
                item = it;
                break;
            }
        }

        if (!item) return _er("SRT לא נמצא בפרויקט");

        // Insert to timeline — Premiere 2025 auto-detects SRT as captions
        var startTime = new Time();
        startTime.seconds = segments[0].start;

        try {
            s.insertClip(item, startTime);
            return _ok({ placed: segments.length, total: segments.length, method: "caption_track", srtPath: srtPath });
        } catch(e1) {
            try {
                s.overwriteClip(item, startTime);
                return _ok({ placed: segments.length, total: segments.length, method: "overwrite_caption", srtPath: srtPath });
            } catch(e2) {
                return _ok({ placed: segments.length, total: segments.length, method: "srt_project", srtPath: srtPath,
                    note: "SRT יובא לפרויקט — גרור ל-Caption Track" });
            }
        }
    } catch(e) { return _er(e.toString()); }
}

function importSRT(srtPath, startSec) {
    try {
        var s = _seq();if (!s) return _er("אין רצף");
        if (!(new File(srtPath)).exists) return _er("קובץ לא נמצא");
        app.project.importFiles([srtPath], true, app.project.rootItem, false);
        var item = null, fname = srtPath.split(/[\/\\]/).pop(), root = app.project.rootItem;
        for (var i = root.children.numItems - 1; i >= 0; i--) {
            var it = root.children[i]; if (it && it.name === fname) { item = it; break; }
        }
        if (!item) return _ok({ placed: false, note: "SRT יובא" });
        try { var t = new Time(); t.seconds = parseFloat(startSec) || 0; s.insertClip(item, t); return _ok({ placed: true }); } catch(e) {}
        return _ok({ placed: false, note: "SRT יובא — גרור ל-Caption Track" });
    } catch(e) { return _er(e.toString()); }
}

/* ── Get Project Directory Path (v4.0) ── */
function getProjectPath(){
  try{
    var proj=app.project;
    if(!proj||!proj.path)return JSON.stringify({ok:false,e:"no project path"});
    var f=new File(proj.path);
    if(!f.parent||!f.parent.exists)return JSON.stringify({ok:false,e:"parent not found"});
    return JSON.stringify({ok:true,path:f.parent.fsName});
  }catch(e){return JSON.stringify({ok:false,e:e.toString()});}
}
