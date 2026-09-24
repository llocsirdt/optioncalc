#!/usr/bin/env node
'use strict';
/**
 * TIME-GATED DECAY STOP — A/B across the live roster.
 *
 * Close a position that has already decayed to <= `decayStop` x what it cost, but only after
 * `decayStopAfter` on the clock. The user's framing (2026-09-22): "effectively a stop loss but gated by
 * time, so we're giving the market a chance to reverse, as our strategies are designed to expect, but
 * trying to salvage capital when the decay would accelerate and likely eat up what is left ... does this
 * happen more often - and therefore save more capital - than the market reverses and brings these
 * positions back into a valuable position."
 *
 * That is exactly what this measures: the arm INCLUDES the reversals it forfeits, because a stopped
 * position simply is not there to recover.
 *
 * Motivation was a counterfactual over 8 days of stored PROD chain snapshots (+$413,850 at 14:30/<=35%,
 * positive on all 8). 8 days is far too thin to act on; this is the 922-day test.
 *
 * Usage: node scripts/candle-spread/sweep-decay-stop.js [--variants v7-20,v6-40] [--days 922] [--anchor]
 */
const path=require('path'), fs=require('fs');
const { runDay5m, load5mDays } = require('../../server/src/candle-spread/backtest/backtest-v6-5m');
const { buildRuns } = require('../../server/src/candle-spread/index');
const { optsFor: buildOpts } = require('../../server/src/candle-spread/backtest/opts-for');
const DIR = path.join(__dirname,'..','..','tests','backtest','backtest-data-5m-nq');
const arg=(n,d)=>{const i=process.argv.indexOf(n);return i>=0?process.argv[i+1]:d;};
const DAYS=parseInt(arg('--days','922'),10);
const ONLY=(arg('--variants','')||'').split(',').map(s=>s.trim()).filter(Boolean);
const usd=n=>(n<0?'-$':'$')+Math.abs(Math.round(n)).toLocaleString('en-US');

const HAS_PX=true;
const optsFor=v=>buildOpts(v,{intradayIV:true,hasPx:HAS_PX,noWings:false,where:'sweep-decay-stop'});
const wrap=v=>(A,p,ctx)=>v.signalFn(A,p,{...ctx,cfg:v.signalCfg||{}});

const days=load5mDays(DIR).slice(-DAYS);
const RUNS=buildRuns().filter(v=>!ONLY.length||ONLY.includes(v.variant));
console.log(`${days.length} days, ${RUNS.length} variants\n`);

function run(v, extra){
  const o={...optsFor(v),...extra};
  const vals=[],fills=[],stops=[]; let cf=0,cp=0;
  for(const d of days){ const r=runDay5m(d.bars,wrap(v),o);
    vals.push(r.terminal); stops.push(r.decayStops||0);
    cf+=r.filled||0; cp+=(r.filled||0)+(r.coverPending||0); }
  const tot=vals.reduce((a,b)=>a+b,0);
  const sorted=[...vals].sort((a,b)=>a-b);
  let peak=0,eq=0,dd=0;
  for(const x of vals){ eq+=x; if(eq>peak)peak=eq; if(peak-eq>dd)dd=peak-eq; }
  return { total:tot, avg:tot/vals.length, worst:sorted[0], dd,
    retDD: dd>0?tot/dd:Infinity, sub1k:vals.filter(x=>x<=-1000).length, sub2k:vals.filter(x=>x<=-2000).length,
    covFill: cp?100*cf/cp:0, stops:stops.reduce((a,b)=>a+b,0) };
}

if(process.argv.includes('--anchor')){
  const v=RUNS.find(x=>x.variant==='v6-20')||RUNS[0];
  const b=run(v,{});
  console.log(`ANCHOR ${v.variant}: total ${usd(b.total)}  avg/day ${usd(b.avg)}  (v6-20 canon is $1,412,935 / $1,532)`);
  process.exit(0);
}
// Arms chosen from the 8-day prod counterfactual: 14:30/35% was its best cell (positive on all 8 days),
// 14:00/35% and 15:00/50% its neighbours on the smooth part of the surface. A 4-arm grid over 922 days
// costs ~75s per variant-arm; the full 12-cell grid would have run 20+ hours.
const GRID=[{gate:'14:00',fr:0.35},{gate:'14:30',fr:0.35},{gate:'15:00',fr:0.50}];

const { parallelMap, workerCount } = require('./lib/parallel');

(async function main(){
// ONE UNIT PER (variant, arm), BASE included. parallelMap forks this script once per worker (--workers N)
// and returns a keyed object; the loop below reads it in CANONICAL order so the table does not depend on
// which core finished first. See lib/parallel.
const UNITS=[];
for(const v of RUNS){
  UNITS.push({key:`${v.variant}\u0000BASE`, v, o:{}});
  for(const g of GRID) UNITS.push({key:`${v.variant}\u0000${g.gate}/${Math.round(g.fr*100)}%`, v, o:{decayStop:g.fr,decayStopAfter:g.gate}});
}
const RES=await parallelMap(UNITS,(u)=>run(u.v,u.o));

const agg={};
console.log(`DECAY-STOP SWEEP${workerCount()>1?` · ${workerCount()} workers`:''}`);
console.log('variant        arm              total        avg/day     worst      maxDD    ret/DD  <=-1k  covFill  stops');
for(const v of RUNS){
  const base=RES[`${v.variant}\u0000BASE`];
  const line=(nm,r)=>console.log(`${v.variant.padEnd(14)} ${nm.padEnd(15)} ${usd(r.total).padStart(12)} ${usd(r.avg).padStart(10)} ${usd(r.worst).padStart(10)} ${usd(r.dd).padStart(10)} ${(r.retDD===Infinity?'inf':r.retDD.toFixed(1)).padStart(7)} ${String(r.sub1k).padStart(5)}  ${r.covFill.toFixed(1)}%  ${String(r.stops).padStart(5)}`);
  line('BASE',base);
  (agg.BASE=agg.BASE||{t:0,w:0,dd:0,n:0}); agg.BASE.t+=base.total; agg.BASE.dd+=base.dd; agg.BASE.n++;
  for(const g of GRID){
    const k=`${g.gate}/${Math.round(g.fr*100)}%`;
    const r=RES[`${v.variant}\u0000${k}`];
    line(k,r);
    (agg[k]=agg[k]||{t:0,dd:0,n:0}); agg[k].t+=r.total; agg[k].dd+=r.dd; agg[k].n++;
  }
  console.log();
}
console.log('\nFLEET ROLL-UP');
console.log('arm              total          vs BASE      sum maxDD');
const B=agg.BASE.t;
for(const k of ['BASE',...GRID.map(g=>`${g.gate}/${Math.round(g.fr*100)}%`)]){
  const a=agg[k]; if(!a) continue;
  console.log(`${k.padEnd(15)} ${usd(a.t).padStart(13)} ${(k==='BASE'?'':usd(a.t-B)).padStart(13)} ${usd(a.dd).padStart(13)}`);
}
})().catch((e)=>{ console.error('\n  ✗ sweep failed:', e && e.message, '\n'); process.exit(2); });
