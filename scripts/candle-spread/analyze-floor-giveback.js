// FLOOR GIVE-BACK ATTRIBUTION (2026-11-18): on variant-days whose rebuilt book floor reached >= 0 and still closed
// negative, split the SETTLED P&L (eod_settlement per-position pnl) between positions held at the peak-floor minute
// and positions opened after it. Usage: node scripts/candle-spread/analyze-floor-giveback.js FROM TO  (run from the repo root)

const fs=require('fs'),path=require('path'),RC=require(process.cwd()+'/server/src/candle-spread/risk-curve');
const [FROM,TO]=process.argv.slice(2);const ARCH='candle-spread-archive';
const agg={days:0,prePnl:0,postPnl:0,postOpens:0,preUncovAtPeak:0,preUncovLoss:0,postCov:0,postUncov:0,postUncovPnl:0,postCovPnl:0,daysWithPostOpens:0,lossFromPost:0,hedgePnl:0};
for(const f of fs.readdirSync(ARCH)){const m=/^NDX_(\d{4}-\d{2}-\d{2})_\1_(.+)\.json$/.exec(f);if(!m||m[1]<FROM||m[1]>TO)continue;
 const r=JSON.parse(fs.readFileSync(path.join(ARCH,f),'utf8'));const st=[...r.events].reverse().find(e=>e.type==='eod_settlement');if(!st)continue;
 const pos=(r.state.positions||[]).filter(p=>p&&p.filled&&p.legs);if(!pos.length)continue;
 const fa=p=>p.fillEpoch||p.openEpoch||p.placedEpoch,ca=p=>p.coverFilledAt||p.coverEpoch;
 const start=Math.min(...pos.map(fa));let peak=-Infinity,pt=null;
 for(let t=start;t<=Date.parse(m[1]+'T21:00:00Z');t+=60000){const b=pos.filter(p=>fa(p)<=t).map(p=>({...p,covered:!!(p.covered&&ca(p)&&ca(p)<=t)}));const fl=RC.bookFloor(b,null,10);if(fl>peak){peak=fl;pt=t;}}
 if(!(peak>=0&&st.terminalPnl<0))continue;
 agg.days++;const pnl=Object.fromEntries((st.positions||[]).map(x=>[x.id,x.pnl]));
 let post=0,pre=0,npost=0;
 for(const p of pos){const v=pnl[p.id]||0;if(p.hedge||p.side==='hedge'){agg.hedgePnl+=v;}
  if(fa(p)>pt){post+=v;npost++;if(p.covered){agg.postCov++;agg.postCovPnl+=v;}else{agg.postUncov++;agg.postUncovPnl+=v;}}
  else{pre+=v;if(!(p.covered&&ca(p)<=pt)){agg.preUncovAtPeak++;}}}
 agg.prePnl+=pre;agg.postPnl+=post;agg.postOpens+=npost;if(npost)agg.daysWithPostOpens++;if(post<0&&post<pre)agg.lossFromPost++;}
const r=n=>Math.round(n);console.log(FROM,'..',TO,JSON.stringify({days:agg.days,daysWithOpensAfterPeak:agg.daysWithPostOpens,opensAfterPeak:agg.postOpens,
 settledPnl_positionsHeldAtPeak:r(agg.prePnl),settledPnl_opensAfterPeak:r(agg.postPnl),afterPeak_uncoveredAtClose:agg.postUncov,afterPeak_uncoveredPnl:r(agg.postUncovPnl),afterPeak_coveredPnl:r(agg.postCovPnl),daysWhereLossMostlyFromAfterPeak:agg.lossFromPost,hedgePnl:r(agg.hedgePnl)}));
