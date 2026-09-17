#!/usr/bin/env node
'use strict';
/**
 * recompute-session-floor.js — what a session's floors really were, once covers booked on impossible
 * quotes are taken out.
 *
 * WHY THIS EXISTS. On 2026-09-16 the chain snapshot broke around 14:00 and legs came back inverted and
 * absurdly wide. markFill's only test was `mark > limit`, which a NEGATIVE mark passes trivially, so 154
 * covers across 55 variants "filled" at one tick on spreads up to 40 wide. A cover that costs nothing
 * looks like a free lock, so the damage runs UPWARD: every floor computed from those books is overstated.
 * The engine is fixed (c25c08d); this recovers what the day actually looked like.
 *
 * It does NOT guess a price for a broken quote. It brackets:
 *
 *   A  NEVER FILLED   the order kept working and the position stayed uncovered. Pessimistic: in reality
 *                     the order goes on working and may fill later in the session.
 *   B  FILLED AT TARGET  the order kept working and eventually filled at the price the engine was aiming
 *                     for, W - openCost - minLock. Fair whenever the market reached that price.
 *
 * Truth sits between them, and which end depends on whether the market came to the price — which is
 * exactly what the broken quotes make unknowable. Report both; never report one as the answer.
 *
 * Usage: node scripts/candle-spread/recompute-session-floor.js [--dir <run json dir>]
 */
const fs=require('fs'),path=require('path');
const RC=require('../../server/src/candle-spread/risk-curve.js');
const SQ=require('../../server/src/candle-spread/spread-quote.js');
const runs=require('../../server/src/candle-spread/index.js').buildRuns();
const DIR=(()=>{const i=process.argv.indexOf('--dir');return i>=0?process.argv[i+1]:path.join(__dirname,'..','..','candle-spread-archive');})();
const day=Date.UTC(2026,8,16),OFF=4*3600e3;
const marks=[];for(let mm=9*60+35;mm<=15*60;mm+=5)marks.push({t:day+mm*60e3+OFF,hm:String(Math.floor(mm/60)).padStart(2,'0')+':'+String(mm%60).padStart(2,'0')});
const r2=n=>Math.round(n*100)/100;

// A cover is BROKEN if the shipped structural gate would refuse the quote it was booked on,
// or if the limit collapsed to a single tick (the tell that the limit itself came from a bad mark).
function broken(p){
  if(!p.covered||!p.coverLegs) return false;
  if(p.coverMarkLow!=null && !SQ.verticalSanity(p.coverLegs,p.coverMarkLow).ok) return true;
  return p.coverLimit!=null && p.coverLimit<=0.05;
}
// What the engine INTENDED to pay: W - openCost - minLock. This is the price a sane quote would have
// produced, so it is the fair counterfactual for "the order kept working and eventually filled".
function intendedLimit(p,minLockFrac){
  const ks=(p.coverLegs||[]).map(l=>l.strike); const W=ks.length?Math.max(...ks)-Math.min(...ks):0;
  if(!W) return null;
  return Math.max(0.05, r2(W-(p.limit||0)-(minLockFrac||0)*W));
}
const bookAt=(pos,t)=>(pos||[]).filter(p=>p.filled!==false&&(p.openEpoch||0)<=t)
  .map(p=>(p.covered&&p.coverEpoch!=null&&p.coverEpoch<=t)?p:{...p,covered:false,coverLegs:null,coverLimit:null});
function traj(pos){
  const tr=marks.map(M=>{const f=RC.bookFloor(bookAt(pos,M.t),null,10);return{hm:M.hm,f:Number.isFinite(f)?f:null};}).filter(x=>x.f!==null);
  if(!tr.length) return null;
  let pk=tr[0]; for(const x of tr) if(x.f>pk.f) pk=x;
  return {peak:pk.f,peakHm:pk.hm,at15:tr[tr.length-1].f};
}
const out=[];
for(const f of fs.readdirSync(DIR)){
  const j=JSON.parse(fs.readFileSync(DIR+'/'+f,'utf8'));const st=(j.run||j).state||{};
  const name=f.replace('.json','');const cfg=runs.find(r=>r.variant===name);
  const pos=st.positions||[]; if(!pos.length) continue;
  const bad=pos.filter(broken);
  const asBooked=traj(pos);
  // A) the order never filled -> the position stays uncovered (pessimistic)
  const A=traj(pos.map(p=>broken(p)?{...p,covered:false,coverLegs:null,coverLimit:null}:p));
  // B) the order kept working and filled at its intended price (fair)
  const B=traj(pos.map(p=>broken(p)?{...p,coverLimit:intendedLimit(p,cfg&&cfg.continuousCoverMinLockFrac)}:p));
  if(!asBooked||!A||!B) continue;
  out.push({v:name,n:bad.length,booked:asBooked,A,B});
}
const $=x=>x==null?'--':(x<0?'-':'')+'$'+Math.abs(Math.round(x)).toLocaleString();
const sum=(rows,sel,k)=>rows.reduce((a,r)=>a+sel(r)[k],0);
const aff=out.filter(r=>r.n>0);
console.log('RECOMPUTE — 2026-09-16, '+out.length+' variants, '+aff.length+' with broken covers ('+aff.reduce((a,r)=>a+r.n,0)+' covers)\n');
console.log('                                 AS BOOKED        A: never filled     B: filled at target');
console.log('  fleet PEAK floor          '+$(sum(out,r=>r.booked,'peak')).padStart(14)+$(sum(out,r=>r.A,'peak')).padStart(20)+$(sum(out,r=>r.B,'peak')).padStart(22));
console.log('  fleet floor at 15:00      '+$(sum(out,r=>r.booked,'at15')).padStart(14)+$(sum(out,r=>r.A,'at15')).padStart(20)+$(sum(out,r=>r.B,'at15')).padStart(22));
const gb=(sel)=>sum(out,sel,'peak')-sum(out,sel,'at15');
console.log('  give-back peak -> 15:00   '+$(gb(r=>r.booked)).padStart(14)+$(gb(r=>r.A)).padStart(20)+$(gb(r=>r.B)).padStart(22));
const pct=(sel)=>(100*gb(sel)/sum(out,sel,'peak')).toFixed(0)+'%';
console.log('  give-back as % of peak    '+pct(r=>r.booked).padStart(14)+pct(r=>r.A).padStart(20)+pct(r=>r.B).padStart(22));
const fell=(sel)=>out.filter(r=>sel(r).at15<sel(r).peak).length;
console.log('  variants that gave back   '+(fell(r=>r.booked)+'/'+out.length).padStart(14)+(fell(r=>r.A)+'/'+out.length).padStart(20)+(fell(r=>r.B)+'/'+out.length).padStart(22));
console.log('\n  most inflated by the bad fills (peak, as booked vs B):');
aff.sort((a,b)=>(b.booked.peak-b.B.peak)-(a.booked.peak-a.B.peak));
for(const r of aff.slice(0,10)) console.log('   '+r.v.padEnd(14),'n='+String(r.n).padStart(2),
  ' peak '+$(r.booked.peak).padStart(10)+' -> '+$(r.B.peak).padStart(10)+'   overstated by '+$(r.booked.peak-r.B.peak).padStart(9));
