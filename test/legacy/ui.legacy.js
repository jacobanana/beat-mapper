// The tempo-map and pin-editing functions of the single-file BeatMapper (jacobanana/appz
// beat-mapper/index.html at 4ed3e24), copied verbatim. Only the wrapper is new: the functions read a
// state object `S` handed in, UI side effects are stubbed, and results come back through `S`.
/* eslint-disable */
// @ts-nocheck
import Core from './core.legacy.js';

export function legacyUi(S, opts = {}) {
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const toasts=[]; const toast=m=>{ toasts.push(m); };
  const pushUndo=()=>{}, syncInputs=()=>{}, updateExportInfo=()=>{};
  const $=id=>({ value: id==='loopBars' ? (opts.loopBars ?? '') : '' , textContent:'' });
  let barsDirty=false, dirty=false;
const barQ=()=>S.num*4/S.den, beatQ=()=>4/S.den;
function gridQ(){ const m={bar:barQ(),'2':2,'4':1,'8':.5,'16':.25,'32':.125,'4t':2/3,'8t':1/3,'16t':1/6}; return Math.min(m[S.grid],barQ()); }
function seg(key,v){ const A=S.anchors, n=A.length; if(v<=A[0][key]) return 0; if(v>=A[n-1][key]) return n-2; let lo=0,hi=n-1; while(hi-lo>1){ const m=(lo+hi)>>1; if(A[m][key]<=v) lo=m; else hi=m; } return lo; }
function posToTime(q){ const A=S.anchors; if(!A.length) return NaN; if(A.length===1) return A[0].t+(q-A[0].q)*60/S.baseBpm; const i=seg('q',q),a=A[i],b=A[i+1]; return a.t+(q-a.q)*(b.t-a.t)/(b.q-a.q); }
function timeToPos(t){ const A=S.anchors; if(!A.length) return NaN; if(A.length===1) return A[0].q+(t-A[0].t)*S.baseBpm/60; const i=seg('t',t),a=A[i],b=A[i+1]; return a.q+(t-a.t)*(b.q-a.q)/(b.t-a.t); }
function gridLevel(j){ if(j===0) return 0; const r=j*gridQ()/beatQ(); return Math.abs(r-Math.round(r))<1e-6?1:2; }
function nearestGridQ(q,maxLevel=2){ const bq=barQ(), gq=gridQ(), b=Math.floor(q/bq+1e-9); let best=b*bq, bd=Math.abs(q-best);
  const c2=(b+1)*bq; if(Math.abs(q-c2)<bd){best=c2;bd=Math.abs(q-c2);}
  for(let j=1;j*gq<bq-1e-9;j++){ if(gridLevel(j)>maxLevel) continue; const c=b*bq+j*gq, d=Math.abs(q-c); if(d<bd){bd=d;best=c;} } return best; }
function bpmAt(t){ if(!S.anchors.length) return NaN; const q=timeToPos(t), e=0.01; return 60*e/(posToTime(q+e)-posToTime(q)); }

function anchorsChanged(){ S.anchors.sort((a,b)=>a.q-b.q); barsDirty=true; dirty=true; $('aCount').textContent=S.anchors.length||''; updateExportInfo(); }
function computeBars(){ S.bars=[]; if(!S.anchors.length) return; const bq=barQ(); for(let b=0;b<5000;b++){ const ts=posToTime(b*bq); if(ts>=S.dur) break; const te=posToTime((b+1)*bq); S.bars.push({b,ts,te,bpm:60*bq/(te-ts)}); } }
function ensureDownbeat(){ if(S.anchors.length) return; const t=S.markers.length?S.markers[0].t:0; S.anchors=[{q:0,t,manual:true}]; anchorsChanged(); toast('Bar 1 set on the first transient'); }
function setDownbeat(T){ if(!S.x) return; pushUndo();
  if(S.anchors.length<=1) S.anchors=[{q:0,t:T,manual:true}];
  else { const qg=nearestGridQ(timeToPos(T)); S.anchors=S.anchors.map(a=>({...a,q:a.q-qg})).filter(a=>a.q>1e-6&&a.t>T+0.01); S.anchors.unshift({q:0,t:T,manual:true}); }
  anchorsChanged(); S.sel={type:'a',ref:S.anchors[0]}; }
function neighbours(q){ let p=null,n=null; for(const a of S.anchors){ if(a.q<q-1e-6) p=a; else if(a.q>q+1e-6){ n=a; break; } } return [p,n]; }
function pinAt(T,qOverride){ if(!S.x) return null; if(!S.anchors.length){ setDownbeat(T); return S.anchors[0]; }
  const q=qOverride!=null?qOverride:nearestGridQ(timeToPos(T)); if(q<-1e-6){ toast('That is before bar 1. Press D to start bar 1 here instead.'); return null; }
  const [p,n]=neighbours(q); if((p&&T<=p.t+0.005)||(n&&T>=n.t-0.005)){ toast("Can't pin there – it would cross a neighbouring pin."); return null; }
  pushUndo(); let a=S.anchors.find(k=>Math.abs(k.q-q)<1e-6); if(a){ a.t=T; a.manual=true; } else { a={q,t:T,manual:true}; S.anchors.push(a); }
  anchorsChanged(); S.sel={type:'a',ref:a}; return a; }
function unpin(a){ if(!a) return; if(a.q===0&&Math.abs(a.q)<1e-9){ return toast('Bar 1 stays pinned. Move it with D or by dragging.'); } pushUndo(); S.anchors=S.anchors.filter(k=>k!==a); S.sel=null; anchorsChanged(); }
function autoMap(){ if(!S.x) return; ensureDownbeat(); if(!S.markers.length) return toast('No transients to map to. Raise the sensitivity in step 1.'); pushUndo();
  const before=S.anchors.length; S.anchors=Core.autoMap(S.anchors.filter(a=>a.manual||a.q===0),S.markers,{stepQ:S.mapEvery==='bar'?barQ():beatQ(),beatQ:beatQ(),tolFrac:S.tol/100,spq:60/S.baseBpm,dur:S.dur});
  S.sel=null; anchorsChanged(); toast(`${S.anchors.length} pins`); }
function deriveFromLoop(){ if(!S.x) return; if(!S.loop||S.loop.b-S.loop.a<0.05) return toast('Draw a loop around the part that is right first (drag in the top ruler).');
  if(!S.markers.length) return toast('No transients to follow. Raise the sensitivity in step 1.');
  const a=S.loop.a, b=S.loop.b, bq=barQ(), old=S.anchors.find(k=>Math.abs(k.q)<1e-9), oldT=old?old.t:null;
  let seeds=S.anchors.filter(k=>k.t>=a-0.02&&k.t<=b+0.02).map(k=>({q:k.q,t:k.t})), how;
  if(seeds.length<2){ let n=Math.round(+$('loopBars').value)||0; if(n<1) n=Math.max(1,Math.round((b-a)/(bq*60/S.baseBpm)));
    const qa=S.anchors.length? Math.round(timeToPos(a)/bq)*bq : 0; seeds=[{q:qa,t:a},{q:qa+n*bq,t:b}]; how=`loop taken as ${n} bar${n>1?'s':''}`; }
  else how=`${seeds.length} pins in the loop kept`;
  pushUndo();
  const first=seeds[0], last=seeds[seeds.length-1], per=(last.t-first.t)/(last.q-first.q), o={stepQ:S.mapEvery==='bar'?bq:beatQ(),beatQ:beatQ(),tolFrac:S.tol/100,dur:S.dur,stopT:0};
  const fwd=Core.trackBeats(S.markers,last.q,last.t,per,1,o), back=Core.trackBeats(S.markers,first.q,first.t,per,-1,o);
  const inner=seeds.length===2&&how.startsWith('loop')? Core.autoMap(seeds.map(k=>({...k,manual:true})),S.markers,{...o,spq:per,dur:last.t}).filter(k=>!k.manual&&k.q>first.q&&k.q<last.q).map(k=>({q:k.q,t:k.t,matched:true})) : [];
  const all=[...back.reverse(),{...first,matched:true,seed:true},...inner,...seeds.slice(1).map(k=>({...k,matched:true,seed:true})),...fwd];
  const onBar=all.filter(k=>Math.abs(k.q/bq-Math.round(k.q/bq))<1e-6); let one=null;
  if(oldT!=null){ for(const k of onBar) if(!one||Math.abs(k.t-oldT)<Math.abs(one.t-oldT)) one=k; }
  else { const t1=S.markers[0].t-0.05; one=onBar.find(k=>k.t>=t1)||onBar[0]; }
  const shift=one?one.q:first.q;
  S.anchors=all.filter(k=>k.matched||k===one).map(k=>({q:k.q-shift,t:k.t,manual:!!k.seed||k===one})).filter(k=>k.q>=-1e-9); if(S.anchors[0]) S.anchors[0].q=0;
  S.baseBpm=clamp(+(60/per).toFixed(2),20,400); syncInputs(); S.sel=null; anchorsChanged();
  toast(`${(60/per).toFixed(2)} BPM · ${how} · ${S.anchors.length} pins`); }
function scaleTempo(f){ pushUndo(); S.baseBpm=clamp(S.baseBpm*f,20,400); S.anchors.forEach(a=>a.q*=f); syncInputs(); anchorsChanged(); }
  return { barQ, beatQ, gridQ, posToTime, timeToPos, gridLevel, nearestGridQ, bpmAt, computeBars, ensureDownbeat, setDownbeat, neighbours, pinAt, unpin, autoMap, deriveFromLoop, scaleTempo, toasts };
}
