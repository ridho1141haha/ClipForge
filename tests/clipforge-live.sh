#!/bin/bash
# ClipForge live API tests — run: bash tests/clipforge-live.sh
# Tests A (duration), C (no transcript), G (duplicate save), H (security), K (subtitles) against http://localhost:3000
set -u
BASE="http://localhost:3000"
PASS=0; FAIL=0
ok()   { ((PASS++)); echo "  ✅ $1"; }
bad()  { ((FAIL++)); echo "  ❌ $1"; }
check(){ if [ "$1" = "0" ]; then ok "$2"; else bad "$2 (got: $3)"; fi; }

echo "== Test A: REAL duration (no fake fallback) =="
RA=$(curl -s -X POST "$BASE/api/youtube/meta" -H 'Content-Type: application/json' -d '{"url":"https://youtu.be/PLOpsj6DVQ8"}')
DUR=$(echo "$RA" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('duration'))")
DSRC=$(echo "$RA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('durationSource'))")
RMD=$(echo "$RA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('requiresManualDuration'))")
TITLE=$(echo "$RA" | python3 -c "import json,sys; print(json.load(sys.stdin).get('title','')[:40])")
echo "    → duration=$DUR source=$DSRC requiresManual=$RMD title=$TITLE"
if [ "$DUR" = "None" ] && [ "$DSRC" = "unavailable" ] && [ "$RMD" = "True" ]; then
  ok "A1: unobtainable duration is EXPLICIT (null + unavailable + manual required) — no fake 720"
elif [ "$DSRC" = "yt-dlp" ] || [ "$DSRC" = "innertube" ]; then
  ok "A2: REAL duration resolved via $DSRC"
else
  bad "A3: unexpected meta response: $RA"
fi

echo "== Analyze body (real-ish transcript) =="
TRANSCRIPT="welcome back everyone. today we are going to talk about the future of artificial intelligence. the first thing you need to understand is how memory works. most people think intelligence is about compute. it is not. it is about memory. and that is why the second rule matters even more. rule number two is simple. always test your assumptions. when we ran the experiment last year the results surprised everyone. the model learned faster with less data. that changed how we build everything now."
WORDS='[{"word":"welcome","start":0.0,"end":0.3},{"word":"back","start":0.3,"end":0.5},{"word":"everyone","start":0.5,"end":0.9},{"word":"today","start":1.0,"end":1.3},{"word":"we","start":1.3,"end":1.45},{"word":"are","start":1.45,"end":1.6},{"word":"going","start":1.6,"end":1.9},{"word":"to","start":1.9,"end":2.0},{"word":"talk","start":2.0,"end":2.3},{"word":"about","start":2.3,"end":2.6},{"word":"the","start":2.6,"end":2.7},{"word":"future","start":2.7,"end":3.1},{"word":"of","start":3.1,"end":3.2},{"word":"artificial","start":3.2,"end":3.7},{"word":"intelligence","start":3.7,"end":4.3},{"word":"the","start":4.5,"end":4.6},{"word":"first","start":4.6,"end":4.9},{"word":"thing","start":4.9,"end":5.1},{"word":"you","start":5.1,"end":5.25},{"word":"need","start":5.25,"end":5.45},{"word":"to","start":5.45,"end":5.55},{"word":"understand","start":5.55,"end":6.1},{"word":"is","start":6.1,"end":6.25},{"word":"how","start":6.25,"end":6.45},{"word":"memory","start":6.45,"end":6.85},{"word":"works","start":6.85,"end":7.2},{"word":"most","start":7.5,"end":7.8},{"word":"people","start":7.8,"end":8.1},{"word":"think","start":8.1,"end":8.4},{"word":"intelligence","start":8.4,"end":9.0},{"word":"is","start":9.0,"end":9.15},{"word":"about","start":9.15,"end":9.45},{"word":"compute","start":9.45,"end":10.0},{"word":"it","start":10.2,"end":10.35},{"word":"is","start":10.35,"end":10.5},{"word":"not","start":10.5,"end":10.8},{"word":"it","start":11.0,"end":11.15},{"word":"is","start":11.15,"end":11.3},{"word":"about","start":11.3,"end":11.6},{"word":"memory","start":11.6,"end":12.1},{"word":"and","start":12.5,"end":12.7},{"word":"that","start":12.7,"end":12.9},{"word":"is","start":12.9,"end":13.05},{"word":"why","start":13.05,"end":13.25},{"word":"the","start":13.25,"end":13.4},{"word":"second","start":13.4,"end":13.75},{"word":"rule","start":13.75,"end":14.05},{"word":"matters","start":14.05,"end":14.45},{"word":"rule","start":14.8,"end":15.05},{"word":"number","start":15.05,"end":15.35},{"word":"two","start":15.35,"end":15.6},{"word":"is","start":15.6,"end":15.75},{"word":"simple","start":15.75,"end":16.2},{"word":"always","start":16.5,"end":16.8},{"word":"test","start":16.8,"end":17.0},{"word":"your","start":17.0,"end":17.15},{"word":"assumptions","start":17.15,"end":17.8},{"word":"when","start":18.1,"end":18.35},{"word":"we","start":18.35,"end":18.5},{"word":"ran","start":18.5,"end":18.75},{"word":"the","start":18.75,"end":18.9},{"word":"experiment","start":18.9,"end":19.5},{"word":"last","start":19.5,"end":19.75},{"word":"year","start":19.75,"end":20.0},{"word":"the","start":20.2,"end":20.35},{"word":"results","start":20.35,"end":20.75},{"word":"surprised","start":20.75,"end":21.3},{"word":"everyone","start":21.3,"end":21.7},{"word":"the","start":22.0,"end":22.15},{"word":"model","start":22.15,"end":22.45},{"word":"learned","start":22.45,"end":22.85},{"word":"faster","start":22.85,"end":23.2},{"word":"with","start":23.2,"end":23.4},{"word":"less","start":23.4,"end":23.65},{"word":"data","start":23.65,"end":24.0},{"word":"that","start":24.3,"end":24.55},{"word":"changed","start":24.55,"end":25.0},{"word":"how","start":25.0,"end":25.2},{"word":"we","start":25.2,"end":25.35},{"word":"build","start":25.35,"end":25.65},{"word":"everything","start":25.65,"end":26.1},{"word":"now","start":26.1,"end":26.5}]'

echo "== Test C+B: analyze WITH transcript (grounding) and without =="
# Session A cookie jar
JA=$(mktemp)
ANALYZE=$(curl -s -c "$JA" -X POST "$BASE/api/clips/analyze" -H 'Content-Type: application/json' -d "{\"title\":\"NO KOMEN, BAGUS BANGET NJIR | WUTHERING WAVES\",\"author\":\"DIMSK\",\"duration\":2383.4,\"durationSource\":\"user-provided\",\"transcript\":$(python3 -c "import json;print(json.dumps('''$TRANSCRIPT'''))" 2>/dev/null || echo '""'),\"words\":$WORDS,\"transcriptSource\":\"manual\",\"platform\":\"shorts\",\"style\":\"podcast\",\"targetDuration\":30,\"clipCount\":6,\"language\":\"en\",\"save\":false}")
CANDS=$(echo "$ANALYZE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('candidates',[])))" 2>/dev/null)
if [ -z "$CANDS" ] || [ "$CANDS" = "0" ] || [ "$CANDS" = "None" ]; then
  bad "analyze-with-transcript returned no candidates: $(echo "$ANALYZE" | head -c 300)"
else
  ok "analyze with transcript returned $CANDS candidates"
  echo "$ANALYZE" | python3 -c "
import json,sys
d=json.load(sys.stdin)
cs=d.get('candidates',[])
n_ok=0; n_verified=0; in_range=0
for c in cs:
    scores=c.get('scores',{})
    t=scores.get('total',0)
    if 0 <= t <= 100: n_ok+=1
    if c.get('hookVerified'): n_verified+=1
    if c.get('contextStatus') in ('PASS','EXTEND','REJECT','UNKNOWN'): in_range+=1
    print(f\"    → [{c['start']:.1f}-{c['end']:.1f}] total={t} ctx={c.get('contextStatus')} verified={c.get('hookVerified')} hook='{(c.get('spokenHook') or '')[:48]}'\")
print(f'CHECK {n_ok} {n_verified} {in_range}')
" > /tmp/clipforge-analyze.txt
  cat /tmp/clipforge-analyze.txt
  NUMS=$(grep CHECK /tmp/clipforge-analyze.txt | awk '{print $2}')
  VER=$(grep CHECK /tmp/clipforge-analyze.txt | awk '{print $3}')
  CTX=$(grep CHECK /tmp/clipforge-analyze.txt | awk '{print $4}')
  [ "$NUMS" = "$CANDS" ] && ok "D(server): all totals are server-calculated 0-100" || bad "D(server): totals out of range"
  [ "$VER" -ge 1 ] 2>/dev/null && ok "B: at least one hook verified against transcript" || bad "B: no hook verified"
  [ "$CTX" = "$CANDS" ] && ok "P7: every candidate has explicit contextStatus" || bad "P7: missing contextStatus"
fi
# count <= requested
if [ -n "$CANDS" ] && [ "$CANDS" != "None" ] && [ "$CANDS" -le 6 ] 2>/dev/null; then
  ok "E: returned ≤ 6 requested clips ($CANDS)"
fi

# analyze WITHOUT transcript
ANALYZE_NT=$(curl -s -b "$JA" -c "$JA" -X POST "$BASE/api/clips/analyze" -H 'Content-Type: application/json' -d '{"title":"Test video no transcript","duration":600,"durationSource":"user-provided","platform":"shorts","style":"podcast","clipCount":4,"language":"en","save":false}')
NT_HOOKS=$(echo "$ANALYZE_NT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
cs=d.get('candidates',[])
empty=sum(1 for c in cs if not (c.get('spokenHook') or '').strip())
unverified=all(not c.get('hookVerified') for c in cs)
print(f'{len(cs)} {empty} {unverified}')" 2>/dev/null)
NTN=$(echo "$NT_HOOKS" | awk '{print $1}'); NTE=$(echo "$NT_HOOKS" | awk '{print $2}'); NTU=$(echo "$NT_HOOKS" | awk '{print $3}')
if [ -n "$NTN" ] && [ "$NTN" != "0" ] && [ "$NTN" != "None" ]; then
  if [ "$NTE" = "$NTN" ] && [ "$NTU" = "True" ]; then
    ok "C: no-transcript mode → all spokenHooks empty + unverified (no fabrication)"
  else
    bad "C: no-transcript mode leaked hooks: $NT_HOOKS"
  fi
else
  echo "    (no-transcript analyze returned: $(echo "$ANALYZE_NT" | head -c 200))"
  bad "C: expected candidates in no-transcript mode"
fi

echo "== Test G: duplicate save does not multiply =="
# create project (session A)
PROJ=$(curl -s -b "$JA" -c "$JA" -X POST "$BASE/api/projects" -H 'Content-Type: application/json' -d '{"youtubeId":"PLOpsj6DVQ8","url":"https://www.youtube.com/watch?v=PLOpsj6DVQ8","title":"Live test project","duration":2383.4,"durationSource":"user-provided"}')
PID=$(echo "$PROJ" | python3 -c "import json,sys; print(json.load(sys.stdin)['project']['id'])" 2>/dev/null)
if [ -z "$PID" ] || [ "$PID" = "None" ]; then bad "project creation failed: $PROJ"; else
  ok "project created ($PID)"
  CLIPS_PAYLOAD="[{'projectId':'$PID','title':'T1','startTime':10,'endTime':40,'score':77,'tags':[],'status':'suggested','platform':'shorts','order':0},{'projectId':'$PID','title':'T2','startTime':50,'endTime':80,'score':66,'tags':[],'status':'suggested','platform':'shorts','order':1}]"
  CLIPS_PAYLOAD=$(echo "$CLIPS_PAYLOAD" | sed "s/'/\"/g")
  curl -s -b "$JA" -c "$JA" -X POST "$BASE/api/clips" -H 'Content-Type: application/json' -d "$CLIPS_PAYLOAD" > /dev/null
  curl -s -b "$JA" -c "$JA" -X POST "$BASE/api/clips" -H 'Content-Type: application/json' -d "$CLIPS_PAYLOAD" > /dev/null
  curl -s -b "$JA" -c "$JA" -X POST "$BASE/api/clips" -H 'Content-Type: application/json' -d "$CLIPS_PAYLOAD" > /dev/null
  PCOUNT=$(curl -s -b "$JA" "$BASE/api/projects/$PID" | python3 -c "import json,sys; p=json.load(sys.stdin)['project']; print(f\"{p['clipCount']} {len(p['clips'])}\")")
  C1=$(echo "$PCOUNT" | awk '{print $1}'); C2=$(echo "$PCOUNT" | awk '{print $2}')
  [ "$C1" = "2" ] && [ "$C2" = "2" ] && ok "G: 3× save → still 2 clips (transactional replace)" || bad "G: clip count multiplied: $PCOUNT"
fi

echo "== Test H: security — user B cannot access A's project =="
JB=$(mktemp)
SA=$(curl -s -o /dev/null -w "%{http_code}" -b "$JB" -c "$JB" "$BASE/api/projects/$PID")
SA2=$(curl -s -o /dev/null -w "%{http_code}" -b "$JB" -c "$JB" -X POST "$BASE/api/clips/analyze" -H 'Content-Type: application/json' -d "{\"title\":\"x\",\"duration\":100,\"projectId\":\"$PID\"}")
ALLC=$(curl -s -o /dev/null -w "%{http_code}" -b "$JB" -c "$JB" "$BASE/api/clips")
LISTA=$(curl -s -b "$JB" -c "$JB" "$BASE/api/projects" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('projects',[])))")
[ "$SA" = "404" ] && ok "H1: foreign project GET → 404" || bad "H1: foreign project GET → $SA"
[ "$SA2" = "404" ] && ok "H2: foreign project analyze → 404" || bad "H2: foreign project analyze → $SA2"
[ "$ALLC" = "400" ] && ok "H3: GET /api/clips without projectId → 400 (never all clips)" || bad "H3: GET /api/clips → $ALLC"
[ "$LISTA" = "0" ] && ok "H4: user B's project list excludes A's projects" || bad "H4: B sees $LISTA projects"

echo "== Test K: SRT/VTT export from REAL transcript =="
# add clip words to project clip
CLIPID=$(curl -s -b "$JA" "$BASE/api/projects/$PID" | python3 -c "import json,sys; p=json.load(sys.stdin)['project']; print(p['clips'][0]['id'] if p['clips'] else '')")
if [ -n "$CLIPID" ]; then
  curl -s -b "$JA" -X PATCH "$BASE/api/clips/$CLIPID" -H 'Content-Type: application/json' -d "{\"clipWords\":$WORDS,\"clipTranscript\":\"$TRANSCRIPT\"}" > /dev/null
  SRT=$(curl -s -b "$JA" -X POST "$BASE/api/export" -H 'Content-Type: application/json' -d "{\"projectId\":\"$PID\",\"format\":\"srt\"}")
  echo "$SRT" | head -6 | sed 's/^/    | /'
  HAS_SPEECH=$(echo "$SRT" | grep -ci "welcome\|memory\|intelligence" || true)
  HAS_TITLE=$(echo "$SRT" | grep -ci "Live test project\|T1\|T2" || true)
  [ "$HAS_SPEECH" -ge 1 ] && ok "K1: SRT contains actual spoken words" || bad "K1: SRT lacks speech"
  [ "$HAS_TITLE" = "0" ] && ok "K2: SRT does NOT contain clip titles (no fabrication)" || bad "K2: SRT contains titles"
  VTT=$(curl -s -b "$JA" -X POST "$BASE/api/export" -H 'Content-Type: application/json' -d "{\"projectId\":\"$PID\",\"format\":\"vtt\"}")
  echo "$VTT" | head -1 | grep -q "WEBVTT" && ok "K3: VTT export works (WEBVTT header)" || bad "K3: VTT broken"
  # srt with no transcript data at all → explicit 422
  PROJ2=$(curl -s -b "$JA" -c "$JA" -X POST "$BASE/api/projects" -H 'Content-Type: application/json' -d '{"youtubeId":"aIRrsesZc9c","url":"https://www.youtube.com/watch?v=aIRrsesZc9c","title":"No transcript project"}')
  PID2=$(echo "$PROJ2" | python3 -c "import json,sys; print(json.load(sys.stdin)['project']['id'])")
  SRT2=$(curl -s -o /tmp/srt2.txt -w "%{http_code}" -b "$JA" -X POST "$BASE/api/export" -H 'Content-Type: application/json' -d "{\"projectId\":\"$PID2\",\"format\":\"srt\"}")
  [ "$SRT2" = "422" ] && ok "K4: SRT without transcript → explicit 422 error (never fabricated)" || bad "K4: expected 422, got $SRT2"
fi

echo "════════════════════════════════"
echo "LIVE RESULT: $PASS passed, $FAIL failed"
exit $FAIL
