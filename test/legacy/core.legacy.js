// Verbatim copy of the Core module from the single-file BeatMapper (jacobanana/appz beat-mapper/index.html
// at 4ed3e24). The parity tests run it next to the TypeScript port and require identical output.
/* eslint-disable */
// @ts-nocheck
const Core = (() => {
  function makeFFT(N){
    const bits = Math.log2(N)|0, rev = new Uint32Array(N), cs = new Float64Array(N/2), sn = new Float64Array(N/2);
    for(let i=0;i<N;i++) rev[i] = (rev[i>>1]>>1) | ((i&1)<<(bits-1));
    for(let i=0;i<N/2;i++){ cs[i]=Math.cos(2*Math.PI*i/N); sn[i]=Math.sin(2*Math.PI*i/N); }
    return (re,im)=>{
      for(let i=0;i<N;i++){ const j=rev[i]; if(j>i){ let t=re[i];re[i]=re[j];re[j]=t; t=im[i];im[i]=im[j];im[j]=t; } }
      for(let size=2; size<=N; size<<=1){
        const half=size>>1, step=N/size;
        for(let i=0;i<N;i+=size) for(let j=0,k=0;j<half;j++,k+=step){
          const a=i+j, b=a+half, xr=re[b], xi=im[b];
          const tr=xr*cs[k]+xi*sn[k], ti=xi*cs[k]-xr*sn[k];
          re[b]=re[a]-tr; im[b]=im[a]-ti; re[a]+=tr; im[a]+=ti;
        }
      }
    };
  }

  // Onset detection functions: four of them from one pass of FFTs, each in three bands (everything,
  // below 250 Hz, above 3 kHz), at frame rate sr/hop. Frame n's value sits at (n*hop-pad+0.6N)/sr.
  //   flux:    spectral flux. The rise in log magnitude since the previous frame, summed over bins.
  //   complex: rectified complex-domain difference (Duxbury, Bello et al. 2003; Dixon 2006). Each bin
  //            is predicted from the previous two frames (same magnitude, phase advancing steadily)
  //            and the distance to what was observed is counted where the magnitude rose. Catches
  //            soft, pitched onsets that barely change loudness.
  //   gdelay:  group delay (Van Belle 2012). A bin's phase slope across frequency says where inside
  //            the window its energy sits, so each bin votes for that instant, weighted by its log
  //            magnitude. A tick collects every vote at one instant; a steady tone votes for the
  //            window centre, which slides along and blurs into a floor.
  //   energy:  the rise in log energy since the previous frame. The plain loudness jump.
  async function analyze(x, sr, onProgress){
    const N = sr>60000 ? 2048 : 1024, hop = N>>2, pad = N, half=N>>1;
    const frames = Math.max(1, Math.floor((x.length+pad-N)/hop)+1);
    const mk=()=>({full:new Float32Array(frames), low:new Float32Array(frames), high:new Float32Array(frames)});
    const odfs={flux:mk(), complex:mk(), gdelay:mk(), energy:mk()}, G=odfs.gdelay, E=odfs.energy;
    const fft=makeFFT(N), re=new Float64Array(N), im=new Float64Array(N), win=new Float64Array(N);
    const prev=new Float32Array(half), ph1=new Float32Array(half), ph2=new Float32Array(half); let e1=0, e1l=0, e1h=0;
    for(let i=0;i<N;i++) win[i]=0.5-0.5*Math.cos(2*Math.PI*i/(N-1));
    const bLow=Math.ceil(250/(sr/N)), bHigh=Math.floor(3000/(sr/N)), sc=4/N*200, TAU=2*Math.PI, gOff=pad-0.6*N, eps=1e-9*N*N;
    for(let n=0;n<frames;n++){
      const off=n*hop-pad;
      for(let i=0;i<N;i++){ const s=off+i; re[i]=(s>=0&&s<x.length? x[s]:0)*win[i]; im[i]=0; }
      fft(re,im);
      let f=0,fl=0,fh=0, c=0,cl=0,ch=0, e=0,el=0,eh=0, pp=Math.atan2(im[0],re[0]);
      for(let b=1;b<half;b++){
        const r=re[b], q=im[b], m2=r*r+q*q, L=Math.log1p(Math.sqrt(m2)*sc), phase=Math.atan2(q,r), band=b<bLow?1:b>=bHigh?2:0, d=L-prev[b];
        if(d>0){
          f+=d; if(band===1) fl+=d; else if(band===2) fh+=d;
          const pr=prev[b], cd=Math.sqrt(Math.max(0, L*L+pr*pr-2*L*pr*Math.cos(phase-2*ph1[b]+ph2[b])));
          c+=cd; if(band===1) cl+=cd; else if(band===2) ch+=cd;
        }
        // Phase step to the previous bin, unwrapped into (-2pi, 0]: a tick at sample p of the window has
        // phase -2pi*k*p/N, so the step is -2pi*p/N and p = -step*N/2pi.
        let dp=phase-pp; pp=phase; while(dp>0) dp-=TAU; while(dp<=-TAU) dp+=TAU;
        const gi=Math.round((off-dp/TAU*N+gOff)/hop);
        if(gi>=0&&gi<frames){ G.full[gi]+=L; if(band===1) G.low[gi]+=L; else if(band===2) G.high[gi]+=L; }
        e+=m2; if(band===1) el+=m2; else if(band===2) eh+=m2;
        prev[b]=L; ph2[b]=ph1[b]; ph1[b]=phase;
      }
      odfs.flux.full[n]=f; odfs.flux.low[n]=fl; odfs.flux.high[n]=fh;
      odfs.complex.full[n]=c; odfs.complex.low[n]=cl; odfs.complex.high[n]=ch;
      E.full[n]=Math.max(0,Math.log(e+eps)-Math.log(e1+eps)); E.low[n]=Math.max(0,Math.log(el+eps)-Math.log(e1l+eps)); E.high[n]=Math.max(0,Math.log(eh+eps)-Math.log(e1h+eps)); e1=e; e1l=el; e1h=eh;
      if((n&2047)===0 && onProgress){ onProgress(n/frames); await new Promise(r=>setTimeout(r,0)); }
    }
    // Group-delay votes land at sample precision from four overlapping windows; a 3-tap smoothing knits them.
    for(const k of ['full','low','high']){ const a=G[k], b=new Float32Array(frames); for(let n=0;n<frames;n++) b[n]=(2*a[n]+(n?a[n-1]:0)+(n+1<frames?a[n+1]:0))/4; G[k]=b; }
    return { odfs, odf:odfs.flux, fr:sr/hop, N, hop, pad, frames, refs:{} };
  }

  const ALGOS=['flux','complex','gdelay','energy'];
  function odfOf(an, algo, band){ return ((an.odfs&&an.odfs[algo])||an.odf)[band]; }
  // Level that counts as "full" for drawing a detection function: its 99th percentile.
  function odfRef(an, algo, band){
    const k=algo+'/'+band; if(an.refs&&an.refs[k]) return an.refs[k];
    const odf=odfOf(an,algo,band), s=Float32Array.from(odf).sort(), r=s[Math.min(s.length-1,Math.floor(s.length*0.99))]||1;
    if(an.refs) an.refs[k]=r; return r;
  }

  function localDiff(odf, w){
    const n=odf.length, ps=new Float64Array(n+1), d=new Float32Array(n);
    for(let i=0;i<n;i++) ps[i+1]=ps[i]+odf[i];
    for(let i=0;i<n;i++){ const a=Math.max(0,i-w), b=Math.min(n,i+w+1); d[i]=odf[i]-(ps[b]-ps[a])/(b-a); }
    return d;
  }

  // Fine placement of a coarse candidate time. The candidate comes from spectral flux, which peaks
  // wherever the most spectral change happens; on a kick or snare that is often the hat or noise layer
  // arriving 10-30 ms after the attack, so the marker used to land on the decay. Here the 65 ms around
  // the candidate is read in two views, in 1 ms blocks:
  //   amp: |x| after a 2-pole ~100 Hz high-pass. What the eye sees on the waveform, minus the sub-bass
  //        ripple that would otherwise look like a rise every half cycle.
  //   dif: |x[j]-x[j-1]|, tilted 6 dB/oct to the highs. Catches a hat or snare over a sustained tone.
  // Per view: main rise = the earliest 1 ms rise near the candidate that is at least 85% of the
  // steepest one (an attack beats a slightly bigger bump behind it, such as a pad beat joining a
  // hat); floor = quietest 6 ms before it; peak = loudest 8 ms after it. The onset is the start of
  // the region above floor+25% of the range that holds the main rise, walked back while above
  // floor+8%, then down to the sample: first sample over the floor, back to where the pre-hit signal
  // was still quiet. A view with less than 1.6:1 contrast abstains (noise alone reads about 1.4:1,
  // a real hit 1.7:1 and up); amp is trusted first, dif second, else the steepest amp rise.
  function refineOnset(x, sr, tc){
    const blk=Math.max(1,Math.round(sr*0.001)), a=Math.max(2,Math.floor((tc-0.045)*sr)), b=Math.min(x.length,Math.ceil((tc+0.02)*sr));
    const nb=Math.floor((b-a)/blk); if(nb<12) return Math.max(0,tc);
    const n=b-a, amp=new Float32Array(n), dif=new Float32Array(n), r=Math.exp(-2*Math.PI*100/sr), w0=Math.max(1,a-Math.round(sr*0.02));
    let y1=0,y2=0,px=x[w0-1],py=0;
    for(let j=w0;j<b;j++){ const v=x[j]; y1=r*(y1+v-px); px=v; y2=r*(y2+y1-py); py=y1; if(j>=a){ amp[j-a]=Math.abs(y2); dif[j-a]=Math.abs(v-x[j-1]); } }
    const c=Math.round((tc*sr-a)/blk);
    const view=(s)=>{
      const h=new Float32Array(nb); let e0=0,e1=0;
      for(let i=0;i<nb;i++){ let m=0; for(let j=i*blk,e=j+blk;j<e;j++) if(s[j]>m) m=s[j]; h[i]=Math.max(m,e0,e1); e1=e0; e0=m; }
      const lo=Math.max(2,c-30), hi=Math.min(nb,c+20); let bi=lo, bd=-1;
      for(let i=lo;i<hi;i++){ const d=h[i]-Math.min(h[i-1],h[i-2]); if(d>bd){bd=d;bi=i;} }
      for(let i=lo;i<bi;i++){ const d=h[i]-Math.min(h[i-1],h[i-2]); if(d>=0.85*bd){ bi=i; break; } }
      let floor=Infinity; for(let j=0;j+6<=bi-1;j++){ let m=0; for(let k=j;k<j+6;k++) m+=h[k]; if(m/6<floor) floor=m/6; }
      if(floor===Infinity){ floor=0; for(let k=0;k<bi;k++) floor+=h[k]; floor=bi? floor/bi : 0; }
      let peak=0; for(let i=bi;i<Math.min(nb,bi+8);i++) if(h[i]>peak) peak=h[i];
      const ratio=peak/(floor+1e-9), ok=peak>1e-4 && ratio>1.6;
      let T=floor+0.25*(peak-floor), i=bi; while(i>0 && h[i-1]>=T) i--;
      // The quietest stretch may predate an earlier hit whose tail this one rides on. The contrast test
      // keeps it, but the walk-backs re-read the floor from the 6 ms right before the region, so the
      // tail is not mistaken for part of this hit.
      if(i>0){ let m=0,n=0; for(let k=Math.max(0,i-6);k<i;k++){ m+=h[k]; n++; } if(n && m/n>floor){ floor=m/n; T=floor+0.25*(peak-floor); i=bi; while(i>0 && h[i-1]>=T) i--; } }
      const Tl=floor+0.08*(peak-floor);
      const i0=i; while(i>0 && i0-i<12 && h[i-1]>=Tl) i--;
      const thr=floor*1.6+0.06*(peak-floor), s0=i*blk, s1=Math.min(n,(bi+2)*blk); let sp=s0;
      while(sp<s1 && s[sp]<=thr) sp++;
      if(sp>=s1) sp=bi*blk;
      const low=floor*1.15+1e-7, lim=Math.max(s0,sp-Math.round(sr*0.002)); let quiet=0, on=sp;
      for(let k=sp-1;k>=lim;k--){ if(s[k]<=low){ if(++quiet>=3) break; } else { quiet=0; on=k; } }
      return { ok, ratio, t:Math.max(0,(a+on-1)/sr), rise:(a+bi*blk)/sr };
    };
    const A=view(amp); if(A.ok) return A.t;
    const D=view(dif);
    // A hit over a loud pad can leave amp short of contrast. Its onset still counts when the bright
    // layer dif found comes clearly later: that is a kick then a hat, not a lone hat (whose amp rise,
    // if any, coincides with dif's). Anything under 1.45:1 is within what noise alone reads.
    if(D.ok && A.ratio>1.45 && D.t-A.t>=0.008) return A.t;
    if(D.ok) return D.t;
    return A.rise;
  }

  // Pulls a time onto a zero crossing so the marker sits where the waveform is at rest, not mid-swing.
  // Looks back first (up to 2 ms): landing before the hit keeps the whole attack. Only when nothing
  // behind crosses zero does it look ahead, and then just 1 ms; otherwise the time is left alone.
  // The reach is short on purpose: a hit riding on a bass note or a low rumble has no zero crossing of
  // its own nearby, and a longer search would drag the marker onto the bass's crossing, well ahead of the hit.
  function snapToZero(x, sr, t){
    const n=x.length; if(n<2) return t;
    const i=Math.max(1,Math.min(n-1,Math.round(t*sr)));
    const cross=(k)=>{ const a=x[k-1], b=x[k]; if(a===0) return k-1; if(b===0) return k; return (a<0)!==(b<0)? k-1+a/(a-b) : -1; };
    const back=Math.round(sr*0.002), fwd=Math.round(sr*0.001);
    for(let k=i;k>=1&&k>i-back;k--){ const c=cross(k); if(c>=0) return c/sr; }
    for(let k=i+1;k<n&&k<=i+fwd;k++){ const c=cross(k); if(c>=0) return c/sr; }
    return t;
  }

  function pickCandidates(an, band, x, sr, algo){
    const odf=odfOf(an,algo||'flux',band), fr=an.fr, d=localDiff(odf, Math.max(2,Math.round(0.1*fr))), m=Math.max(1,Math.round(0.016*fr));
    const raw=[];
    for(let n=1;n<odf.length-1;n++){
      if(d[n]<=0) continue;
      let ok=true; const v=odf[n];
      for(let k=Math.max(0,n-m);k<=Math.min(odf.length-1,n+m);k++){ if(odf[k]>v || (odf[k]===v&&k<n)){ok=false;break;} }
      if(ok) raw.push({n, d:d[n]});
    }
    if(!raw.length) return [];
    const sorted=raw.map(r=>r.d).sort((a,b)=>a-b), ref=sorted[Math.min(sorted.length-1,Math.floor(sorted.length*0.98))]||1;
    const out=[];
    for(const r of raw){
      const s=Math.min(1,r.d/ref); if(s<0.02) continue;
      const tc=(r.n*an.hop-an.pad+0.6*an.N)/sr;
      out.push({t:snapToZero(x,sr,refineOnset(x,sr,tc)), s, off:false});
    }
    out.sort((a,b)=>a.t-b.t);
    return out;
  }

  function sensToThr(sens){ return Math.pow(1-sens/100, 3); }

  // Which candidates the settings let through: above the threshold, and the strongest within each gap.
  // Deleted (off) candidates still count here, so taking one out doesn't let a weaker neighbour it was
  // beating take its place. Only rerun when the detection settings change.
  function detectMarkers(cands, thr, gap){
    const out=[];
    for(const c of cands){
      if(c.s<thr) continue;
      const last=out[out.length-1];
      if(last && c.t-last.t<gap){ if(c.s>last.s) out[out.length-1]=c; }
      else out.push(c);
    }
    return out;
  }

  // The markers shown: the detected ones minus the deleted, plus the ones placed by hand.
  function filterMarkers(detected, manual){
    const out=detected.filter(c=>!c.off);
    if(!manual.length) return out;
    const res=out.filter(c=>!manual.some(m=>Math.abs(m.t-c.t)<0.005)).concat(manual);
    res.sort((a,b)=>a.t-b.t);
    return res;
  }

  function estimateTempo(odf, fr){
    const d=localDiff(odf, Math.max(2,Math.round(0.1*fr))), n=Math.min(d.length, 120000);
    const start=Math.max(0,Math.floor((d.length-n)/2));
    const v=new Float32Array(n); for(let i=0;i<n;i++) v[i]=Math.max(0,d[start+i]);
    const lo=Math.floor(fr*60/220), hi=Math.min(n-2,Math.ceil(fr*60/48));
    if(hi<=lo+2) return 120;
    const ac=new Float64Array(hi+2);
    for(let lag=lo-1;lag<=hi+1;lag++){ let s=0; for(let i=0;i+lag<n;i++) s+=v[i]*v[i+lag]; ac[lag]=s/(n-lag); }
    let best=lo, bs=-1;
    for(let lag=lo;lag<=hi;lag++){
      const bpm=60*fr/lag, pr=Math.exp(-0.5*Math.pow(Math.log2(bpm/115)/0.8,2));
      const dbl=2*lag<=hi+1? ac[2*lag]*0.5:0, sc=(ac[lag]+dbl)*pr;
      if(sc>bs){bs=sc;best=lag;}
    }
    const y0=ac[best-1], y1=ac[best], y2=ac[best+1], den=(y0-2*y1+y2), sh=den? 0.5*(y0-y2)/den : 0;
    return 60*fr/(best+Math.max(-0.5,Math.min(0.5,sh)));
  }

  function lowerBound(arr, t){ let lo=0, hi=arr.length; while(lo<hi){ const m=(lo+hi)>>1; if(arr[m].t<t) lo=m+1; else hi=m; } return lo; }
  function bestMarker(markers, pred, tol, after, before){
    let best=null, bs=0;
    for(let i=lowerBound(markers,pred-tol); i<markers.length && markers[i].t<=pred+tol; i++){
      const m=markers[i]; if(m.t<=after || m.t>=before) continue;
      const sc=(0.35+0.65*(m.s==null?1:m.s))*(1-0.8*Math.abs(m.t-pred)/tol);
      if(sc>bs){bs=sc;best=m;}
    }
    return best;
  }

  // Follows the beat outward from a known point. The tracker keeps its own smoothed phase and period, so one
  // off-beat hit can't drag it away; pins still land exactly on the transient that was chosen.
  function trackBeats(markers, q0, t0, per0, dir, o){
    const out=[], step=o.stepQ, eps=1e-6; let per=per0, pq=q0, ph=t0, lastPin=t0, errAvg=-1;
    let k=dir>0? Math.floor(q0/step+eps)+1 : Math.ceil(q0/step-eps)-1;
    for(let n=0;n<200000;n++,k+=dir){
      const q=k*step, pred=ph+(q-pq)*per; if(dir>0? pred>=o.dur : pred<(o.stopT||0)) break;
      const tol=o.tolFrac*o.beatQ*per; if(errAvg<0) errAvg=tol*0.3; const sig=Math.max(0.012,Math.min(tol*0.5,2.5*errAvg)); let best=null, bs=0.1;
      for(let i=lowerBound(markers,pred-tol); i<markers.length && markers[i].t<=pred+tol; i++){
        const m=markers[i]; if(dir>0? m.t<=lastPin+0.01 : m.t>=lastPin-0.01) continue;
        const d=m.t-pred, nx=m.t+dir*step*per, j=lowerBound(markers,nx-sig);
        const support=j<markers.length && markers[j].t<=nx+sig ? 1.5 : 1;
        const sc=(0.35+0.65*(m.s==null?1:m.s))*Math.exp(-0.5*d*d/(sig*sig))*support;
        if(sc>bs){bs=sc;best=m;}
      }
      if(best){ const e=best.t-pred; errAvg=0.7*errAvg+0.3*Math.abs(e); per+=0.2*e/(q-pq); per=Math.max(per0*0.7,Math.min(per0*1.4,per)); ph=pred+0.7*e; lastPin=best.t; out.push({q,t:best.t,matched:true}); }
      else { ph=pred; errAvg=Math.min(tol*0.3,errAvg*1.25); out.push({q,t:pred,matched:false}); }
      pq=q;
    }
    return out;
  }

  // Beat tracking constrained by the user's pins. Positions q are in quarter notes.
  function autoMap(manual, markers, o){
    const M=manual.slice().sort((a,b)=>a.q-b.q), out=M.map(a=>({q:a.q,t:a.t,manual:true})), step=o.stepQ, eps=1e-6;
    for(let s=0;s<M.length-1;s++){
      const A=M[s], B=M[s+1]; let pq=A.q, pt=A.t;
      for(let k=Math.floor(A.q/step+eps)+1; k*step<B.q-eps; k++){
        const q=k*step, slope=(B.t-pt)/(B.q-pq), pred=pt+(q-pq)*slope;
        const m=bestMarker(markers,pred,o.tolFrac*o.beatQ*slope,pt+0.01,B.t-0.01);
        if(m){ out.push({q,t:m.t,manual:false}); pq=q; pt=m.t; }
      }
    }
    const L=M[M.length-1]; let per=o.spq;
    if(M.length>1){ const P=M[M.length-2]; per=(L.t-P.t)/(L.q-P.q); }
    for(const p of trackBeats(markers,L.q,L.t,per,1,o)) if(p.matched) out.push({q:p.q,t:p.t,manual:false});
    out.sort((a,b)=>a.q-b.q);
    return out;
  }

  // ---- MIDI ----
  function vlq(n){ const b=[n&127]; while((n>>=7)>0) b.unshift((n&127)|128); return b; }
  function track(events){
    events.sort((a,b)=>a.tick-b.tick || a.pr-b.pr);
    const bytes=[]; let last=0;
    for(const e of events){ bytes.push(...vlq(e.tick-last), ...e.data); last=e.tick; }
    bytes.push(0,0xFF,0x2F,0);
    const len=bytes.length;
    return [0x4D,0x54,0x72,0x6B,(len>>>24)&255,(len>>>16)&255,(len>>>8)&255,len&255,...bytes];
  }
  function metaText(type,str){ const b=[...new TextEncoder().encode(str)]; return [0xFF,type,...vlq(b.length),...b]; }
  function simplifySig(n16){ if(n16%4===0) return [n16/4,4]; if(n16%2===0) return [n16/2,8]; return [n16,16]; }

  // One plan feeds both writers. points: {tick, time (s in the project), bpm (quarter notes/min), sig?:[n,d]}
  function planExport(o){
    const ppq=480, barQ=o.num*4/o.den, beatQ=4/o.den, A=o.anchors.filter(a=>a.q>=-1e-9);
    let pts=[];
    if(o.mode==='pins'){
      pts=A.map(a=>({q:a.q,t:a.t}));
      if(pts.length===1) pts.push({q:pts[0].q+barQ, t:pts[0].t+barQ*60/o.baseBpm});
    } else {
      const step=o.mode==='bar'?barQ:beatQ;
      for(let k=0;k<100000;k++){ const q=k*step, t=o.posToTime(q); pts.push({q,t}); if(t>=o.dur && k>0) break; }
    }
    const P=[]; for(const p of pts){ const tick=Math.round(p.q*ppq); if(!P.length || (tick>P[P.length-1].tick && p.t>P[P.length-1].t)) P.push({tick,t:p.t}); }
    const t0=P[0].t, spq0=(P[1].t-P[0].t)/((P[1].tick-P[0].tick)/ppq), lead=!o.trimmed && t0>0.002, shift=o.trimmed? -t0 : 0;
    let leadTicks=0, leadBpm=null, n16=0, bars=0; const points=[];
    if(lead){
      n16=Math.max(1,Math.round(t0/(spq0/4))); leadTicks=n16*ppq/4; leadBpm=60*(n16/4)/t0;
      const bar16=o.num*16/o.den, r=n16%bar16; bars=Math.floor(n16/bar16)+(r?1:0);
      points.push({tick:0,time:0,bpm:leadBpm,sig:r? simplifySig(r) : [o.num,o.den]});
      if(r&&r<n16) points.push({tick:r*ppq/4,time:t0*r/n16,bpm:leadBpm,sig:[o.num,o.den]});
    }
    for(let i=0;i<P.length-1;i++){
      const bpm=60*((P[i+1].tick-P[i].tick)/ppq)/(P[i+1].t-P[i].t), tick=leadTicks+P[i].tick;
      const needSig=i===0 && (!lead || points[points.length-1].sig[0]!==o.num || points[points.length-1].sig[1]!==o.den);
      points.push({tick,time:P[i].t+shift,bpm,sig:needSig?[o.num,o.den]:null});
    }
    let minB=Infinity,maxB=0,count=0,last=-1;
    for(const p of points){ const u=Math.round(6e7/p.bpm); if(u!==last){ count++; last=u; } if(p.tick>=leadTicks){ if(p.bpm<minB)minB=p.bpm; if(p.bpm>maxB)maxB=p.bpm; } }
    return { ppq, points, leadTicks, beatQ, info:{count, minB, maxB, t0, leadBpm, leadBars:bars, songBpm:60/spq0, n16} };
  }

  function buildExport(o){
    const plan=planExport(o), ppq=plan.ppq, leadTicks=plan.leadTicks, beatQ=plan.beatQ;
    const ev=[{tick:0,pr:0,data:metaText(3,'Tempo map')}]; let lastU=-1;
    for(const p of plan.points){
      if(p.sig) ev.push({tick:p.tick,pr:1,data:[0xFF,0x58,4,p.sig[0],Math.log2(p.sig[1])|0,24,8]});
      const u=Math.max(1,Math.min(0xFFFFFF,Math.round(6e7/p.bpm))); if(u===lastU) continue; lastU=u;
      ev.push({tick:p.tick,pr:2,data:[0xFF,0x51,3,(u>>>16)&255,(u>>>8)&255,u&255]});
    }
    const tracks=[track(ev)];
    if(o.clicks){
      const nv=[{tick:0,pr:0,data:metaText(3,'Click')}], bt=Math.round(beatQ*ppq), len=Math.max(10,Math.round(bt/4));
      const add=(tick,down)=>{ const n=down?76:77, v=down?112:84; nv.push({tick,pr:4,data:[0x99,n,v]},{tick:tick+len,pr:3,data:[0x89,n,0]}); };
      for(let j=1; leadTicks-j*bt>=0; j++) add(leadTicks-j*bt,false);
      const endQ=o.timeToPos(o.dur);
      for(let k=0;k*beatQ<endQ && k<200000;k++) add(leadTicks+Math.round(k*beatQ*ppq), k%o.num===0);
      tracks.push(track(nv));
    }
    const head=[0x4D,0x54,0x68,0x64,0,0,0,6,0,1,0,tracks.length,(ppq>>8)&255,ppq&255];
    const total=head.length+tracks.reduce((s,t)=>s+t.length,0), bytes=new Uint8Array(total);
    bytes.set(head,0); let p=head.length; for(const t of tracks){ bytes.set(t,p); p+=t.length; }
    return { bytes, info:plan.info };
  }

  // ---- REAPER project (.rpp). Field layout follows the community "State Chunk Definitions" (ReaTeam/Doc):
  // PT <seconds> <bpm> <shape 1=square> [<65536*den+num> <selected> <flags &1 = set time signature>]
  function rppQuote(n){ if(!n.includes('"')) return '"'+n+'"'; if(!n.includes("'")) return "'"+n+"'"; return '"'+n.replace(/"/g,'')+'"'; }
  function rppSourceType(name){ const e=(name.split('.').pop()||'').toLowerCase();
    return {wav:'WAVE',wave:'WAVE',bwf:'WAVE',w64:'WAVE',aif:'WAVE',aiff:'WAVE',mp3:'MP3',flac:'FLAC',ogg:'VORBIS',oga:'VORBIS',opus:'OPUS'}[e]||'VIDEO'; }
  function buildRpp(o){
    const plan=planExport(o), L=[], pts=plan.points, f=plan.points[0], sig0=f.sig||[o.num,o.den];
    L.push(`<REAPER_PROJECT 0.1 "7.0/BeatMapper" ${Math.floor(Date.now()/1000)}`,'  RIPPLE 0',`  TEMPO ${f.bpm.toFixed(10)} ${sig0[0]} ${sig0[1]}`);
    L.push('  <TEMPOENVEX','    ACT 1 -1','    VIS 1 0 1','    LANEHEIGHT 0 0','    ARM 0','    DEFSHAPE 1 -1 -1');
    let prevB=-1; for(const p of pts){ if(!p.sig&&Math.abs(p.bpm-prevB)<1e-7) continue; prevB=p.bpm; L.push(`    PT ${Math.max(0,p.time).toFixed(12)} ${p.bpm.toFixed(10)} 1`+(p.sig? ` ${65536*p.sig[1]+p.sig[0]} 0 1`:'')); }
    L.push('  >');
    if(o.fileName){ const off=o.trimmed? plan.info.t0 : 0;
      L.push('  <TRACK',`    NAME ${rppQuote(o.trackName||'Audio')}`,'    BEAT 0','    <ITEM','      POSITION 0',`      LENGTH ${(o.dur-off).toFixed(12)}`,'      LOOP 0','      BEAT 0',
        `      NAME ${rppQuote(o.fileName)}`,`      SOFFS ${off.toFixed(12)}`,`      <SOURCE ${rppSourceType(o.fileName)}`,`        FILE ${rppQuote(o.fileName)}`,'      >','    >','  >'); }
    L.push('>','');
    return { text:L.join('\n'), info:plan.info, points:pts };
  }

  // A REAPER project holding the slices: one item per slice on a single track, each at the time it was
  // cut from, so the arrangement is rebuilt from the .wav files beside the .rpp. The tempo map rides
  // along whenever the beats have been mapped.
  function buildRppSlices(o){
    let plan=null; if(o.anchors&&o.anchors.length){ try{ plan=planExport(o); }catch(e){ plan=null; } }
    const f=plan&&plan.points[0], sig=(f&&f.sig)||[o.num,o.den], bpm=f? f.bpm : o.baseBpm, L=[];
    L.push(`<REAPER_PROJECT 0.1 "7.0/BeatMapper" ${Math.floor(Date.now()/1000)}`,'  RIPPLE 0',`  TEMPO ${bpm.toFixed(10)} ${sig[0]} ${sig[1]}`);
    if(plan){
      L.push('  <TEMPOENVEX','    ACT 1 -1','    VIS 1 0 1','    LANEHEIGHT 0 0','    ARM 0','    DEFSHAPE 1 -1 -1');
      let prevB=-1; for(const p of plan.points){ if(!p.sig&&Math.abs(p.bpm-prevB)<1e-7) continue; prevB=p.bpm; L.push(`    PT ${Math.max(0,p.time).toFixed(12)} ${p.bpm.toFixed(10)} 1`+(p.sig? ` ${65536*p.sig[1]+p.sig[0]} 0 1`:'')); }
      L.push('  >');
    }
    L.push('  <TRACK',`    NAME ${rppQuote(o.trackName||'Slices')}`,'    BEAT 0');
    for(const sl of o.slices) L.push('    <ITEM',`      POSITION ${Math.max(0,sl.t0).toFixed(12)}`,`      LENGTH ${(sl.t1-sl.t0).toFixed(12)}`,'      LOOP 0','      BEAT 0',
      `      NAME ${rppQuote(sl.name)}`,'      SOFFS 0',`      <SOURCE ${rppSourceType(sl.name)}`,`        FILE ${rppQuote(sl.name)}`,'      >','    >');
    L.push('  >','>','');
    return L.join('\n');
  }

  // ---- WAV (PCM, interleaved, 16 or 24-bit) ----
  function wavEncode(chans, sr, bits){
    const ch=chans.length, n=chans[0].length, bps=bits===24?3:2, dataLen=n*ch*bps;
    const out=new Uint8Array(44+dataLen), v=new DataView(out.buffer), W=(p,str)=>{ for(let i=0;i<str.length;i++) out[p+i]=str.charCodeAt(i); };
    W(0,'RIFF'); v.setUint32(4,36+dataLen,true); W(8,'WAVEfmt '); v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,ch,true);
    v.setUint32(24,sr,true); v.setUint32(28,sr*ch*bps,true); v.setUint16(32,ch*bps,true); v.setUint16(34,bits===24?24:16,true); W(36,'data'); v.setUint32(40,dataLen,true);
    let p=44;
    if(bits===24) for(let i=0;i<n;i++) for(let c=0;c<ch;c++){ const q=Math.max(-8388607,Math.min(8388607,Math.round(chans[c][i]*8388607))); out[p]=q&255; out[p+1]=(q>>8)&255; out[p+2]=(q>>16)&255; p+=3; }
    else for(let i=0;i<n;i++) for(let c=0;c<ch;c++){ v.setInt16(p,Math.max(-32767,Math.min(32767,Math.round(chans[c][i]*32767))),true); p+=2; }
    return out;
  }
  function wavBytes(x, sr){ return wavEncode([x], sr, 16); }

  // ---- sample slicing ----
  // Every transient starts a slice. A transient closer than minLen to the one that started the previous
  // slice is passed over, so that slice simply keeps running. In 'gap' mode a slice runs to the next
  // transient plus a tail, in 'fixed' mode for a set length; either way it stops at the end of the file.
  function planSlices(times, o){
    const dur=o.dur, from=Math.max(0,o.from||0), to=Math.min(dur,o.to==null?dur:o.to), minLen=o.minLen||0, B=[];
    for(const t of times){ if(t<from-1e-9||t>=to-1e-6) continue; if(B.length && t-B[B.length-1]<minLen) continue; B.push(t); }
    const out=[];
    for(let i=0;i<B.length;i++){
      const t0=B[i], next=i+1<B.length? B[i+1] : to;
      const t1=Math.min(dur, o.mode==='fixed'? t0+o.len : next+(o.tail||0));
      if(t1-t0<0.002) continue;
      out.push({i:out.length, t0, t1, next});
    }
    return out;
  }

  // One slice, exactly as it will be written: the samples between t0 and t1, raised-cosine fades at both
  // ends so nothing clicks, optionally mixed to mono and normalized to a target peak.
  function renderSlice(chans, sr, t0, t1, o){
    o=o||{};
    const len=chans[0].length, s0=Math.max(0,Math.round(t0*sr)), s1=Math.max(s0+1,Math.min(len,Math.round(t1*sr))), n=s1-s0, out=[];
    if(o.mono && chans.length>1){ const m=new Float32Array(n); for(const c of chans) for(let i=0;i<n;i++) m[i]+=c[s0+i]/chans.length; out.push(m); }
    else for(const c of chans){ const d=new Float32Array(n); for(let i=0;i<n;i++) d[i]=c[s0+i]; out.push(d); }
    const fi=Math.min(n,Math.round((o.fadeIn||0)*sr)), fo=Math.min(n,Math.round((o.fadeOut||0)*sr));
    for(const d of out){
      for(let i=0;i<fi;i++) d[i]*=0.5-0.5*Math.cos(Math.PI*i/fi);
      for(let i=0;i<fo;i++) d[n-1-i]*=0.5-0.5*Math.cos(Math.PI*i/fo);
    }
    let peak=0; for(const d of out) for(let i=0;i<n;i++){ const v=d[i]<0?-d[i]:d[i]; if(v>peak) peak=v; }
    if(o.normalize && peak>1e-6){ const tg=o.target==null?0.891:o.target, gain=tg/peak; for(const d of out) for(let i=0;i<n;i++) d[i]*=gain; peak=tg; }
    return { chans:out, n, sr, peak };
  }

  // ---- ZIP (stored) ----
  let crcT=null;
  function crc32(u8){ if(!crcT){ crcT=new Uint32Array(256); for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c=c&1?0xEDB88320^(c>>>1):c>>>1; crcT[n]=c>>>0; } }
    let c=0xFFFFFFFF; for(let i=0;i<u8.length;i++) c=crcT[(c^u8[i])&255]^(c>>>8); return (c^0xFFFFFFFF)>>>0; }
  function zipStore(name, data){ return zipFiles([{name,data}]); }
  function zipFiles(files){
    const enc=new TextEncoder(), d=new Date(), dt=((d.getFullYear()-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate(), tm=(d.getHours()<<11)|(d.getMinutes()<<5)|(d.getSeconds()>>1);
    const F=files.map(f=>({nm:enc.encode(f.name),data:f.data,crc:crc32(f.data)}));
    let size=22; for(const f of F) size+=30+46+2*f.nm.length+f.data.length;
    const out=new Uint8Array(size), v=new DataView(out.buffer); let p=0;
    for(const f of F){ f.off=p;
      v.setUint32(p,0x04034b50,true); v.setUint16(p+4,20,true); v.setUint16(p+6,0x0800,true); v.setUint16(p+8,0,true); v.setUint16(p+10,tm,true); v.setUint16(p+12,dt,true);
      v.setUint32(p+14,f.crc,true); v.setUint32(p+18,f.data.length,true); v.setUint32(p+22,f.data.length,true); v.setUint16(p+26,f.nm.length,true); v.setUint16(p+28,0,true);
      out.set(f.nm,p+30); out.set(f.data,p+30+f.nm.length); p+=30+f.nm.length+f.data.length; }
    const cd=p;
    for(const f of F){
      v.setUint32(p,0x02014b50,true); v.setUint16(p+4,20,true); v.setUint16(p+6,20,true); v.setUint16(p+8,0x0800,true); v.setUint16(p+10,0,true); v.setUint16(p+12,tm,true); v.setUint16(p+14,dt,true);
      v.setUint32(p+16,f.crc,true); v.setUint32(p+20,f.data.length,true); v.setUint32(p+24,f.data.length,true); v.setUint16(p+28,f.nm.length,true);
      v.setUint32(p+42,f.off,true); out.set(f.nm,p+46); p+=46+f.nm.length; }
    v.setUint32(p,0x06054b50,true); v.setUint16(p+8,F.length,true); v.setUint16(p+10,F.length,true); v.setUint32(p+12,p-cd,true); v.setUint32(p+16,cd,true);
    return out;
  }

  // ---- demo: a drum loop whose tempo drifts ----
  function synthDemo(sr){
    let seed=12345; const rnd=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);
    const bars=16, beats=[], lead=0.372; let t=lead;
    for(let i=0;i<=bars*4;i++){ beats.push(t); const ph=i/(bars*4); const bpm=94+7*ph+2.2*Math.sin(ph*9); t+=60/bpm; }
    const dur=beats[bars*4]+0.6, x=new Float32Array(Math.ceil(dur*sr)), onsets=[];
    const put=(t0,len,fn)=>{ const s=Math.round(t0*sr), n=Math.round(len*sr); for(let i=0;i<n&&s+i<x.length;i++) x[s+i]+=fn(i/sr,i); };
    for(let i=0;i<bars*4;i++){
      const b=beats[i], nb=beats[i+1], pos=i%4;
      if(pos===0||pos===2){ onsets.push(b); let ph=0; put(b,0.28,(tt)=>{ const f=48+95*Math.exp(-tt/0.035); ph+=2*Math.PI*f/sr; return 0.85*Math.sin(ph)*Math.exp(-tt/0.11)*Math.min(1,tt/0.0015); }); }
      else { onsets.push(b); put(b,0.2,(tt)=>(0.5*(rnd()*2-1)*Math.exp(-tt/0.05)+0.35*Math.sin(2*Math.PI*190*tt)*Math.exp(-tt/0.04))*Math.min(1,tt/0.001)); }
      for(let h=0;h<2;h++){ const ht=b+(nb-b)*h/2+(h? (rnd()-0.5)*0.008:0); if(h) onsets.push(ht); let pv=0; put(ht,0.06,(tt)=>{ const r=rnd()*2-1, o=r-pv; pv=r; return 0.16*o*Math.exp(-tt/0.015); }); }
    }
    onsets.sort((a,b)=>a-b);
    return { x, beats, onsets, dur };
  }

  return { analyze, pickCandidates, ALGOS, odfOf, odfRef, detectMarkers, filterMarkers, sensToThr, estimateTempo, autoMap, trackBeats, buildExport, buildRpp, buildRppSlices, planExport, wavBytes, wavEncode,
    planSlices, renderSlice, zipFiles, zipStore, crc32, synthDemo, lowerBound, snapToZero };
})();
export default Core;
