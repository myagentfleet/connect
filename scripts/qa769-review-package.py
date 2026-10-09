import base64,hashlib,html,json,os,re,stat,struct,urllib.error,urllib.request,zipfile
from pathlib import Path
from datetime import datetime,timezone

SOURCE="fd173c1c153e1f893494963675472ad4e448a7ce"
PREVIOUS="0996a76f1a3d963cde7f0d10b211c5cd02fb0c0e"
BASE="109edb39ffa7a4ad3c38788ca2f39a286538ff07"
REPO="myagentfleet/connect"
ROOT=Path("review-work")
OUT=Path("review-output")
RUNS=[
 ("final-chrome",11620335347,"f6a3844bb5fef3b8e17f4c8cd56e382dfc00d12929a96d8c3c8abdba76199a5f",37938004740,SOURCE,"169 tests in 17 files, lint, build, and two focused Chrome scenarios."),
 ("final-native",11620515234,"d382768325746d5da5bef604377b9c4ff955fc6b22a471bc84395140c1c68c95",37938052645,SOURCE,"Two focused native-HLS recovery cases and touch contrast. Patched macOS WebKit with iPhone emulation; acceptanceRun=false."),
 ("full-chrome",11619026407,"25520e6edfd30c95840a52636adff9e538d262a1c5ae0849506bba70e949beb4",37936570974,PREVIOUS,"All seven unfiltered Chrome scenarios, plus the unit/lint/build gate."),
 ("full-native",11618751816,"8ed7a57ab392b16c44f6652ea35d7b096b666909c26c61796fe4d7a7939576e4",37936618330,PREVIOUS,"Seven native cases: three observations and four passing cases. Manifest repair uses the inherited 200ms check. The visual review found the touch defect later fixed."),
 ("production-reference",11618295671,"fb44c29f90487844145a0c94296387fcc30a2d27d83b2d10e92c68406f40f9e5",37934434822,"2d3bca154c33b09416f9826fad113863adb25946","Stock Safari, plain video outside Connect. Complete and gap blocks each run synthetic/public/public/synthetic. All eight start; all four gap targets miss, including both public-production cases. Public clips have no audio."),
 ("safari-reference",11616926951,"592613f354bbf1a154adcf8f7b06c5753d40d925aaa2146eddb2b4924666f228",37932181369,"8276cd68b3ac31da150fc8b4566fb29e479e2f65","Stock Safari: four original plus four packet-preserved video-only MSE sessions pass their probes; one of four native controls has the gap failure. Fresh sessions, not fresh Safari processes."),
 ("upstream",11598800977,"b3d98e7d8bccefa08580fdde240cbdd9e3d9bb18e47e78e7b6e086805575da79",37891933708,BASE,"Earlier headed Chrome design captures of the same synthetic media, paused at 45s.")
]
def require(ok,message):
 if not ok:raise RuntimeError(message)
def sha(data):return hashlib.sha256(data).hexdigest()
def esc(value):return html.escape(str(value),quote=True)
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
def recover(name,artifact,digest):
 api=f"https://api.github.com/repos/{REPO}/actions/artifacts/{artifact}/zip"
 request=urllib.request.Request(api,headers={"Authorization":"Bearer "+os.environ["QA769_READ_TOKEN"],"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"})
 try:
  try:
   with urllib.request.build_opener(NoRedirect).open(request,timeout=30) as response: location=None;data=response.read(100_000_001)
  except urllib.error.HTTPError as error:
   if error.code not in (301,302,303,307,308):raise
   location=error.headers.get("Location")
  if location:
   require(location.startswith("https://"),"Unexpected artifact redirect")
   # Follow the GitHub-provided redirect without forwarding the API credential.
   with urllib.request.urlopen(location,timeout=45) as response:data=response.read(100_000_001)
  require(len(data)<=100_000_000,"Oversized artifact")
  require(sha(data)==digest,"Artifact digest mismatch")
 except Exception:
  raise RuntimeError(f"Could not recover and verify artifact {artifact}") from None
 folder=ROOT/name;folder.mkdir(parents=True,exist_ok=True)
 archive=ROOT/(name+".zip");archive.write_bytes(data)
 with zipfile.ZipFile(archive) as z:
  require(z.testzip() is None,"Corrupt artifact ZIP")
  for entry in z.infolist():
   path=Path(entry.filename)
   require(not path.is_absolute() and ".." not in path.parts and not stat.S_ISLNK(entry.external_attr>>16),"Unsafe artifact path")
  z.extractall(folder)
 print(f"Verified artifact {artifact}: {name}",flush=True)
 return folder
ROOT.mkdir(exist_ok=True);OUT.mkdir(exist_ok=True)
reports={};metadata=[];evidence={}
for name,artifact,digest,run,source,scope in RUNS:
 folder=recover(name,artifact,digest);data=(folder/"report.json").read_bytes();report=json.loads(data)
 require(report.get("sha",report.get("sourceSha"))==source,"Wrong report source: "+name)
 require((folder/"source-sha.txt").read_text().strip()==source,"Wrong source guard: "+name)
 reports[name]=report
 metadata.append(dict(name=name,artifact=artifact,archive_sha256=digest,archive_digest_verified=True,run=run,url=f"https://github.com/{REPO}/actions/runs/{run}",source=source,scope=scope,report_sha256=sha(data),case_filter=report.get("caseFilter"),recorded_cases=[dict(name=c["name"],status=c.get("status")) for c in report["cases"]]))
 evidence[name+"/report.json"]=data;evidence[name+"/source-sha.txt"]=(folder/"source-sha.txt").read_bytes()
c=reports["final-chrome"];n=reports["final-native"];b=reports["upstream"]
require(c["passed"] and n["passed"],"Final report failed")
require([x["name"] for x in c["cases"]]==["comparison-healthy-player","controls-and-responsive"],"Wrong focused Chrome scope")
require([x["name"] for x in n["cases"]]==["native-missed-seek-retry","native-missed-seek-seek"],"Wrong focused native scope")
require(n["acceptanceRun"] is False and n["observeFrames"] is False and n["diagnosticBuildTransforms"]==[],"Native scope differs")
require(reports["full-chrome"]["caseFilter"] is None and len(reports["full-chrome"]["cases"])==7,"Wrong preceding Chrome scope")
require(b["captureOnly"] and b["fixtureSha256"]==c["fixtureSha256"] and b["browser"]==c["browser"],"Comparison provenance differs")
require(all(d["cases"][0]["capturedMedia"]["time"]==45 and d["cases"][0]["capturedMedia"]["paused"] for d in [b,c]),"Comparison is not paused at 45s")
ansi=re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
test=ansi.sub("",(ROOT/"final-chrome/test.log").read_text());lint=ansi.sub("",(ROOT/"final-chrome/lint.log").read_text())
require(re.search(r"^\s*Tests\s+169 passed\s+\(169\)",test,re.M) and re.search(r"^\s*Test Files\s+17 passed\s+\(17\)",test,re.M),"Unit totals differ")
require("Found 0 warnings and 0 errors." in lint,"Lint differs")
for filename in ["test.log","lint.log","browser.log"]:evidence["final-chrome/"+filename]=(ROOT/"final-chrome"/filename).read_bytes()
req=json.loads(Path("reviews/769/requirements-review.json").read_text())
require(req["sourceSha"]==SOURCE and req["fullIssueRequirementsSatisfied"] is False and req["changeSize"]["netTextLines"]==959,"Requirement record differs")
for key,name in [("finalDesktop","final-chrome"),("finalNativeTouch","final-native"),("precedingFullChrome","full-chrome"),("precedingNative","full-native")]:
 require(req["evidenceSnapshot"][key]["reportSha256"]==sha((ROOT/name/"report.json").read_bytes()),"Independent report hash differs: "+name)
images={};panels=[];states=[];options=[]
def picture(key,filename,title,caption):
 require(filename in reports[key]["screenshots"],"Unrecorded screenshot")
 data=(ROOT/key/filename).read_bytes();require(data[:8]==b"\x89PNG\r\n\x1a\n","Invalid PNG")
 width,height=struct.unpack(">II",data[16:24]);source=next(x[4] for x in RUNS if x[0]==key)
 images[key+"/"+filename]=dict(sha256=sha(data),bytes=len(data),dimensions=[width,height],source=source)
 uri="data:image/png;base64,"+base64.b64encode(data).decode()
 return f'<figure><figcaption><strong>{esc(title)}</strong><span>{esc(caption)}</span></figcaption><button class="shot" type="button" aria-label="View original: {esc(title)}"><img src="{uri}" alt="{esc(title)} — recorded application screenshot" data-name="{esc(filename)}" width="{width}" height="{height}" loading="lazy"></button><small>{key} · source {source[:12]} · {width} × {height}px</small></figure>'
for width in [320,390,1280,1600]:
 filename=f"comparison-video-{width}.png"
 require((ROOT/"final-chrome"/filename).read_bytes()==(ROOT/"full-chrome"/filename).read_bytes(),"Final CSS changed a stable layout capture")
 pair=picture("upstream",filename,"Upstream player",f"{width}px configured viewport · paused at 45s · earlier capture")+picture("final-chrome",filename,"Revised player",f"{width}px configured viewport · paused at 45s · final source")
 panels.append(f'<div class="pair" data-panel="{width}"'+(" hidden" if width!=390 else "")+">"+pair+"</div>")
labels={
"native-missed-seek-retry-error-390.png":("Native seek failure before Retry","Native time clamped at 60s while the timeline retained about 124.909s."),
"native-missed-seek-retry-recovered-390.png":("Retry after media repair","The paused frame reads 124.800s; sampled currentTime is 124.909s."),
"native-missed-seek-retry-resumed-390.png":("Resumed after Retry","The picture advances to 126.800s; the white Play circle remains visible after pause."),
"native-missed-seek-seek-error-390.png":("Native seek failure before a new selection","Native time clamped at 120s while the timeline retained about 124.909s."),
"native-missed-seek-seek-recovered-390.png":("New healthy seek with the middle still missing","The picture reads 9.800s; the middle segment still returns HTTP404."),
"native-missed-seek-seek-resumed-390.png":("Resumed after the healthy seek","The picture advances to 11.800s; the white Play circle remains visible after pause."),
"native-missed-seek-error-small-320.png":("Native error at 320px","Error and Retry remain inside the video. The pointer tooltip is a preview, not a changed selection."),
"native-missed-seek-map-390.png":("Map during a video error","Video error controls do not cover Map. Selected timeline time is retained."),
"native-missed-seek-return-video-390.png":("Return to Video","The actionable error returns; the same media element stays mounted."),
"primary-control-hover-390.png":("Desktop primary-button hover","The circle is light gray with a dark icon before and after capture."),
"files-menu-390.png":("Files menu","Settled, readable menu; keyboard dismissal restores trigger focus."),
"route-info-menu-390.png":("More info menu","Settled popup with full opacity, identity transform and no active animations."),
"keyboard-focus-390.png":("Keyboard focus","A visible solid two-pixel outline identifies the jump control."),
"speed-menu-keyboard-390.png":("Playback speed menu","Selected rate and keyboard focus are separately visible.")
}
default="native-missed-seek-retry-resumed-390.png"
for key,group in [("final-chrome","Final Chrome"),("final-native","Native HLS · emulated iPhone")]:
 options.append(f'<optgroup label="{esc(group)}">')
 for filename in sorted(set(reports[key]["screenshots"])):
  if filename.startswith("comparison-"):continue
  title,caption=labels.get(filename,(filename[:-4].replace("-"," ").title(),"Recorded final-source state; measurements and commands are in the evidence report."))
  if filename.startswith("map-"):caption="Production WebGL route/marker with a deterministic plain map style. Live tiles are outside this check."
  if filename.startswith("timeline-hover-"):caption="Pointer preview is distinct from the selected playback time."
  states.append(f'<div data-state="{filename}"'+(" hidden" if filename!=default else "")+">"+picture(key,filename,title,caption)+"</div>")
  options.append(f'<option value="{filename}"'+(" selected" if filename==default else "")+">"+esc(title)+"</option>")
 options.append("</optgroup>")
require(len(images)==35,"Expected 35 images")
frames=[]
for case,burns in zip(n["cases"],[(124.8,126.8),(9.8,11.8)]):
 for phase,media,burn in [("Recovered paused",case["recoveredMedia"],burns[0]),("After resumed playback",case["resumedMedia"],burns[1])]:
  require(abs(media["time"]-burn)<0.6,"Previously reviewed frame no longer matches report")
  frames.append(dict(case=case["name"],phase=phase,clock=media["time"],burned_timestamp=burn,difference=abs(media["time"]-burn)))
 for sample in case["primaryAfterPause"].values():
  require(sample["hoverNone"] and sample["hovered"] and not sample["active"] and sample["background"]=="rgb(255, 255, 255)" and sample["opacity"]=="1" and sample["rect"]["width"]==44 and sample["rect"]["height"]==44,"Touch style proof differs")
for sample in c["cases"][1]["primaryHover"].values():
 require(sample["hovered"] and sample["hoverCapable"] and sample["background"]=="rgb(229, 233, 236)","Desktop hover proof differs")
status=dict(source=SOURCE,base=BASE,tree="b364deed0e5add454e199f84d5d3308df90cab6f",repository=REPO,author="Agent Fleet <myagentfleet@gmail.com>",committer="Agent Fleet <myagentfleet@gmail.com>",issue_fully_resolved=False,upstream_pr_opened=False,generated_utc=datetime.now(timezone.utc).isoformat(),packaging_run=os.environ.get("GITHUB_RUN_ID"),checks=dict(tests=169,test_files=17,lint_warnings=0,lint_errors=0,build="passed in final Chrome CI",final_chrome_cases=2,final_native_cases=2,preceding_chrome_cases=7,preceding_native_cases=7),diff=req["changeSize"],requirements=req["matrix"],runs=metadata,screenshots=images,native_frame_review=frames,desktop_primary_hover=c["cases"][1]["primaryHover"],native_primary_after_pause={x["name"]:x["primaryAfterPause"] for x in n["cases"]},visual_review="The retained findings were completed before the workspace reset: seven current desktop images and all nine native images independently inspected. Restored original archives match their digests; this packaging does not perform a new browser run or new visual inspection.",limitations=req["openAcceptanceItems"],evidence_hashes={k:sha(v) for k,v in evidence.items()})
(OUT/"status.json").write_text(json.dumps(status,indent=2)+"\n")
for filename in ["README.md","PR_DRAFT.md","requirements-review.json"]:
 (OUT/filename).write_bytes((Path("reviews/769")/filename).read_bytes())
for filename in ["status.json","README.md","PR_DRAFT.md","requirements-review.json"]:evidence["review/"+filename]=(OUT/filename).read_bytes()
evidence["screenshot-manifest.json"]=(json.dumps(images,indent=2)+"\n").encode()
with zipfile.ZipFile(OUT/"evidence.zip","w",compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for filename,data in sorted(evidence.items()):z.writestr(filename,data)
css="""*{box-sizing:border-box}body{margin:0;background:#101719;color:#f0f5f6;font:16px/1.65 system-ui,sans-serif}main{max-width:1440px;margin:auto;padding:44px 30px 64px}a{color:#91d4f8}h1{font-size:clamp(34px,5vw,56px);line-height:1.1;letter-spacing:-.03em;max-width:1000px}h2{font-size:27px;line-height:1.3}section{margin-top:42px}p{max-width:1100px}.eyebrow{color:#91d4f8;letter-spacing:.1em;text-transform:uppercase;font-size:12px}.notice{padding:20px 24px;border:1px solid #776744;border-radius:14px;background:#29271f}.notice strong{color:#f0d293}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:24px 0}.stats div{padding:18px;background:#1a2428;border:1px solid #34454c;border-radius:12px}.stats strong{display:block;font-size:26px}.stats span,.note,small{color:#b8c8ce;font-size:13px}nav{display:flex;gap:22px;flex-wrap:wrap;padding:18px 0;border-block:1px solid #34454c;margin:24px 0}button,select{font:inherit;color:#f0f5f6;background:#152025;border:1px solid #34454c;border-radius:8px;min-height:44px;padding:9px 14px}button{cursor:pointer}button[aria-pressed=true]{background:#91d4f8;color:#14242c;font-weight:700}button:focus-visible,select:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid #91d4f8;outline-offset:4px}.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:20px 0}.toolbar span{margin-left:auto}.pair{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start}[hidden]{display:none!important}figure{margin:0;border:1px solid #34454c;border-radius:12px;background:#1a2428;overflow:hidden;min-width:0}figcaption{padding:15px 18px;border-bottom:1px solid #34454c}figcaption strong,figcaption span{display:block}figcaption span{font-size:13px;color:#b8c8ce;margin-top:4px}.shot{display:block;width:100%;padding:0;border:0;border-radius:0;background:#101619}.shot img{display:block;max-width:100%;width:auto;height:auto;margin:auto}small{display:block;padding:10px 15px;overflow-wrap:anywhere}.state-grid{display:grid;grid-template-columns:minmax(0,590px) minmax(0,1fr);gap:28px;align-items:start}.state-controls{position:sticky;top:20px}.state-controls select{width:100%;margin:10px 0 20px}.table-wrap{overflow:auto;border:1px solid #34454c;border-radius:12px;margin:20px 0}table{border-collapse:collapse;text-align:left;width:100%;font-size:14px}th,td{padding:14px 16px;border-bottom:1px solid #34454c;vertical-align:top}th{background:#1a2428;color:#b8c8ce;font-size:12px;text-transform:uppercase}td:first-child{min-width:170px}.scope{display:block;color:#b8c8ce;font-size:13px;margin-top:6px}details{border:1px solid #34454c;border-radius:12px;padding:16px 20px;margin-top:20px}summary{cursor:pointer;font-weight:600}pre{font:12px/1.6 monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:450px;overflow:auto}li+li{margin-top:8px}.files{display:flex;gap:20px;flex-wrap:wrap}footer{margin-top:40px;border-top:1px solid #34454c;padding-top:20px;color:#b8c8ce;font-size:13px}dialog{padding:0;border:1px solid #34454c;border-radius:12px;background:#101719;color:#f0f5f6;max-width:96vw;max-height:94dvh}dialog::backdrop{background:#000d}.dialog-top{position:sticky;top:0;background:#1a2428;padding:12px 18px;display:flex;justify-content:space-between;gap:20px}#original-image{display:block;width:auto;height:auto;max-width:none}@media(max-width:900px){.stats{grid-template-columns:1fr 1fr}.state-controls{position:static}}@media(max-width:700px){main{padding:26px 16px}.pair,.state-grid{grid-template-columns:1fr}.state-controls{grid-row:1}.toolbar span{width:100%;margin-left:0}h2{font-size:24px}}"""
js="""document.querySelectorAll('[data-width]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-width]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));document.querySelectorAll('[data-panel]').forEach(x=>{x.hidden=x.dataset.panel!==b.dataset.width;});document.getElementById('width-note').textContent=b.dataset.width+' CSS-pixel viewport';}));const selector=document.getElementById('state-select');selector.addEventListener('change',()=>document.querySelectorAll('[data-state]').forEach(x=>{x.hidden=x.dataset.state!==selector.value;}));const dialog=document.getElementById('original-dialog');let opener;document.querySelectorAll('.shot').forEach(b=>b.addEventListener('click',()=>{opener=b;const img=b.querySelector('img');document.getElementById('original-title').textContent=b.closest('figure').querySelector('strong').textContent;const original=document.getElementById('original-image');original.src=img.src;original.alt=img.alt;const download=document.getElementById('original-download');download.href=img.src;download.download=img.dataset.name;dialog.showModal();}));document.getElementById('close-original').addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>{if(opener)opener.focus();});"""
rows="".join(f'<tr><td><a href="{x["url"]}">{esc(x["name"])}</a><span class="scope">source {x["source"][:12]}</span></td><td>{esc(x["scope"])}</td></tr>' for x in metadata if x["name"]!="upstream")
reqrows="".join(f'<tr><td>{esc(x["requirement"])}</td><td>{esc(x["status"])}</td><td>{esc(x["reason"])} {esc(x.get("limit",x.get("remaining","")))}</td></tr>' for x in req["matrix"])
framerows="".join(f'<tr><td>{"Retry" if "retry" in x["case"] else "New healthy seek"} · {x["phase"]}</td><td>{x["clock"]:.6f}</td><td>{x["burned_timestamp"]:.3f}</td><td>{x["difference"]:.3f}s</td></tr>' for x in frames)
page=f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect #769 — implementation and visual review</title><style>{css}</style></head><body><main>
<header><div class="eyebrow">Connect · issue #769 · implementation review</div><h1>A clearer player, with playback driven by the video.</h1><p>The video clock now drives shared progress. The controls form one responsive panel, and the demonstrated native missed-seek failure has an explicit recovery path.</p><nav><a href="#design">Before and after</a><a href="#states">Interaction states</a><a href="#evidence">Validation</a><a href="#requirements">Requirements</a><a href="#files">Files</a></nav></header>
<div class="notice"><strong>Full issue acceptance remains open.</strong><p>Physical iOS/Android browsers, installed PWAs and the reported iOS audio behavior still require direct testing. An intermittent patched-WebKit MSE startup concern remains unresolved. The entire source contribution is <strong>+959 text lines</strong>, so the literal net-red requirement is unmet. No upstream PR has been opened.</p><a href="https://github.com/{REPO}/commit/{SOURCE}">Reviewed source {SOURCE[:12]}</a></div>
<div class="stats"><div><strong>169 / 169</strong><span>Final-source unit tests</span></div><div><strong>4 widths</strong><span>320, 390, 1280 and 1600 CSS pixels</span></div><div><strong>2 + 2</strong><span>Final focused Chrome + native cases</span></div><div><strong>35 images</strong><span>Unedited original screenshots</span></div></div>
<section id="design"><h2>The design in the actual application</h2><p>Choose a viewport to compare upstream with the final source. Both use identical synthetic media paused at 45 seconds in headed {esc(c["browser"])}. The upstream capture is earlier. These are recorded screenshots, not a running application or a performance benchmark.</p><div class="toolbar" role="group" aria-label="Comparison viewport">{"".join(f'<button type="button" data-width="{w}" aria-pressed="{str(w==390).lower()}">{w}px</button>' for w in [320,390,1280,1600])}<span class="note" id="width-note" aria-live="polite">390 CSS-pixel viewport</span></div>{"".join(panels)}<p class="note">Select a screenshot to inspect or download its original pixels. No image was retouched or re-encoded. Full-page image dimensions can differ from the configured viewport because of scrollbars and content height.</p></section>
<section id="states"><h2>Recorded interaction states</h2><div class="state-grid"><div>{"".join(states)}</div><aside class="state-controls"><label for="state-select"><strong>Inspect a captured state</strong></label><select id="state-select">{"".join(options)}</select><h3>Clear hierarchy and direct interaction</h3><p>Video, thumbnail filmstrip, time ruler and transport controls share one dark panel. A bright primary action sits with ten-second jumps, speed and audio controls. The map, playhead and labels follow video progress; thumbnails index the visible timeline range.</p><h3>The Play circle stays visible after touch</h3><p>The final CSS correction preserves white under touch hover and retains the light-gray desktop response. Both native cases record actual hover under hover:none, no active press, a white background, dark icon, full opacity and a 44 × 44 CSS-pixel control before and after capture.</p><p>Settled Files and More info menus remain readable and restore focus after dismissal. Keyboard focus has a visible two-pixel outline. Loading and error controls no longer obstruct Map.</p><p class="note">The independent desktop reviewer inspected seven current images, and all nine native images were inspected. All 35 files are inventoried here. Native application captures are patched macOS WebKit with iPhone emulation, not physical iOS or branded Safari. Map styles are deterministic fixtures.</p></aside></div></section>
<section><h2>A failed native seek keeps the selected time.</h2><p>Stock desktop Safari reproduced the missed native seek outside Connect with unchanged public-production media. The guard checks a finite current-source target after a native seek settles with current data. A time mismatch greater than 0.5 seconds, together with nonempty seekable ranges excluding the target within a 0.5-second margin, produces an explicit error before the clamped time is published.</p><p>In the final cases, the native clocks clamped at 60 and 120 seconds while the timeline retained approximately 124.909 seconds. Retry recovered after the missing middle media was repaired. A new healthy seek recovered near 10 seconds while the middle still returned HTTP404. The video element stayed mounted.</p><div class="table-wrap"><table><thead><tr><th>Final native capture</th><th>Media clock (s)</th><th>Burned timestamp (s)</th><th>Difference</th></tr></thead><tbody>{framerows}</tbody></table></div><p class="note">Pointer coordinates select approximately 124.909s for the requested 125s and 9.818s for 10s. These are the actual recorded selections. Startup and resume probes use two seconds and a later counter increase; screenshots follow paused measurements, and earlier screenshots can affect rendering.</p><details><summary>Boundaries of this recovery</summary><p>The live adapter state covers native fallback. The guard does not restore missing footage, detect a seek that never completes, or identify a wrong picture when clock/ranges appear valid. Low readiness, empty seekable ranges and targets already clamped by duration normalization remain limitations. The tested default-start sequence reaches the first available segment; there is no unconditional initial-seek exemption.</p><p>No automatic reload timer or decoder-reset workaround was added. A late ended event cannot restart a failed loop automatically or discard retained play intent.</p></details></section>
<section id="evidence"><h2>Validation by exact source and scope</h2><p>The final source passes 169 tests, lint and the production build. The broader seven-case runs belong to the preceding source; the final one-line CSS correction received focused follow-ups. Older runs have not been relabeled as current-source runs.</p><div class="table-wrap"><table><thead><tr><th>Run</th><th>Recorded scope and result</th></tr></thead><tbody>{rows}</tbody></table></div><details><summary>Failures and diagnostic limits remain visible</summary><p>The first native-guard unit run passed 167 of 169 tests because the DOM fixture left video.error undefined. Commit0996a76 models the observed null state without weakening assertions or changing production. <a href="https://github.com/{REPO}/actions/runs/37936159281">The failed run is retained.</a></p><p>Earlier patched-WebKit MSE startups failed intermittently. A stock Safari reference passed four original and four packet-preserved video-only MSE sessions; that does not establish elimination of the earlier problem. References use fresh WebDriver sessions, not fresh Safari processes, and do not execute the new application guard.</p><p>Native application evidence uses no RVFC observer or diagnostic source transforms, and acceptanceRun remains false. The preceding native manifest-repair case has a shorter 200ms check. The full Chrome suite has one explicitly forced-MSE case and documented gallery flags; the final two cases do not run that forced case. Empty pageErrors does not mean warning-free logs.</p></details></section>
<section id="requirements"><h2>Requirement-by-requirement status</h2><p>The <a href="https://github.com/commaai/connect/issues/769">issue</a> and <a href="https://github.com/commaai/connect/blob/{BASE}/README.md#contributing">repository contribution rules</a> remain the acceptance basis.</p><div class="table-wrap"><table><thead><tr><th>Requirement</th><th>Status</th><th>Evidence and remaining work</th></tr></thead><tbody>{reqrows}</tbody></table></div><h3>Contribution structure and the net-red rule</h3><p>The full diff changes 48 files: 42 text files and six binary fixtures. It contains 2,238 additions and 1,279 deletions. Tests add a net989 lines; all non-test text is−30 and production excluding demo is−182. These subtotals do not make the entire contribution net red.</p><p>Independent demo support can be reviewed separately. The player should retain its meaningful regressions, while QA and review evidence stay outside the application diff. Splitting files, minifying code or deleting tests merely to change the count would not resolve the requirement.</p><h3>Remaining acceptance work</h3><ol><li>Physical iOS and Android browser playback with healthy production routes and missing-media cases.</li><li>Installed mobile PWAs, background/foreground, interruptions and OS media behavior.</li><li>Audible output, synchronization, Bluetooth and direct reproduction of the reported iOS audio behavior.</li><li>An evidence-supported disposition of the remaining desktop MSE startup concern.</li><li>A maintainable net-red contribution and final line-by-line review before upstream submission.</li></ol></section>
<section id="files"><h2>Review files</h2><div class="files"><a href="README.md">Review guide</a><a href="status.json">Status and provenance</a><a href="requirements-review.json">Requirement record</a><a href="PR_DRAFT.md">Unposted PR draft</a><a href="evidence.zip">Original reports and review records</a></div><p class="note">This package reconstructs the completed review after the local workspace reset. All seven original archives are checked against their original digests. Packaging does not rerun the application tests or create new browser observations. The viewer receives structural, image-hash and JavaScript syntax checks; it is not another browser acceptance run.</p><details><summary>Screenshot manifest</summary><pre>{esc(json.dumps(images,indent=2))}</pre></details></section><footer>Agent Fleet &lt;myagentfleet@gmail.com&gt; · source {SOURCE}. Full issue acceptance remains open.</footer></main><dialog id="original-dialog" aria-labelledby="original-title"><div class="dialog-top"><div><strong id="original-title">Original screenshot</strong><br><a id="original-download" download>Download original PNG</a></div><button type="button" id="close-original">Close</button></div><img id="original-image" alt=""></dialog><script>{js}</script></body></html>'''
(OUT/"index.html").write_text(page);(OUT/"viewer-script.js").write_text(js)
for origin,name in [(ROOT/"final-chrome/comparison-video-1600.png","player-desktop.png"),(ROOT/"final-chrome/comparison-video-390.png","player-mobile.png"),(ROOT/"final-native/native-missed-seek-retry-resumed-390.png","native-recovery.png")]:
 (OUT/name).write_bytes(origin.read_bytes())
# Check the reconstructed viewer without representing it as a browser run.
from html.parser import HTMLParser
class Check(HTMLParser):
 def __init__(self):super().__init__();self.images=[];self.ids=[];self.panels=[];self.options=[]
 def handle_starttag(self,tag,attrs):
  a=dict(attrs)
  if "id" in a:self.ids.append(a["id"])
  if tag=="img" and a.get("src","").startswith("data:"):self.images.append(a)
  if "data-state" in a:self.panels.append(a["data-state"])
  if tag=="option":self.options.append(a["value"])
check=Check();check.feed(page)
require(len(check.ids)==len(set(check.ids)) and sorted(check.panels)==sorted(check.options),"Viewer structure differs")
require(len(check.images)==35,"Viewer image count differs")
require(sorted(sha(base64.b64decode(x["src"].split(",",1)[1],validate=True)) for x in check.images)==sorted(x["sha256"] for x in images.values()),"Embedded image hashes differ")
import subprocess
subprocess.run(["node","--check",str(OUT/"viewer-script.js")],check=True)
(OUT/"viewer-script.js").unlink()
files=sorted(x for x in OUT.iterdir() if x.is_file())
(OUT/"SHA256SUMS").write_text("".join(sha(p.read_bytes())+"  "+p.name+"\n" for p in files))
files.append(OUT/"SHA256SUMS")
with zipfile.ZipFile(OUT/"connect-769-review.zip","w",compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for p in files:z.write(p,"connect-769-review/"+p.name)
print(json.dumps(dict(packaged=True,source=SOURCE,original_images=35,final_tests=169,full_issue_resolved=False,files=[x.name for x in OUT.iterdir()])),flush=True)
