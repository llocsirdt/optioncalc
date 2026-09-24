#!/usr/bin/env node
'use strict';
/**
 * CAPITAL POLICY SWEEP — the two arbitrary knobs that decide debit vs credit.
 *
 *   openAlternateEvery (default 3)  — opens alternate debit/credit in blocks of N
 *   creditCoverFrac    (default .65) — a cover goes CREDIT when the POSITION marks >= frac x width
 *
 * Both were set by hand and never measured. They matter because a CREDIT cover lands its short leg on the
 * open's short strike, so the pair collapses to a BUTTERFLY and the capital is released; a DEBIT cover
 * shares no strike and stacks both debits. Measured live 2026-09-18/21/22: net capital per position
 * -$798 credit-covered vs +$953 debit-covered.
 *
 * P&L is parity-identical between a spread and its twin on 0DTE cash-settled NDX, so the objective here is
 * CAPITAL (peakReal = the account this policy actually needs), with P&L watched only to confirm it does
 * not move. The backtest assumes a credit order fills where its debit twin would; live fill rates over
 * those three days (credit 84.8/94.1/71.7% vs debit 69.4/73.9/80.8%) show no systematic penalty, but it
 * is an assumption, not a measurement.
 *
 * Usage: node scripts/candle-spread/sweep-capital-policy.js [--days 400] [--variants a,b] [--knob alt|frac|both]
 */
const path=require('path');
const { runDay5m, load5mDays } = require('../../server/src/candle-spread/backtest/backtest-v6-5m');
const { buildRuns } = require('../../server/src/candle-spread/index');
const { optsFor: buildOpts } = require('../../server/src/candle-spread/backtest/opts-for');
const arg=(n,d)=>{const i=process.argv.indexOf(n);return i>=0?process.argv[i+1]:d;};
const DAYS=parseInt(arg('--days','400'),10);
const KNOB=arg('--knob','both');
const ONLY=(arg('--variants','')||'').split(',').map(s=>s.trim()).filter(Boolean);
const usd=n=>(n<0?'-$':'$')+Math.abs(Math.round(n)).toLocaleString('en-US');
const days=load5mDays(path.join(__dirname,'..','..','tests','backtest','backtest-data-5m-nq')).slice(-DAYS);
const RUNS=buildRuns().filter(v=>!ONLY.length||ONLY.includes(v.variant));
const wrap=v=>(A,p,ctx)=>v.signalFn(A,p,{...ctx,cfg:v.signalCfg||{}});
console.log(`${days.length} days, ${RUNS.length} variants\n`);

function run(v, extra){
  const o={...buildOpts(v,{intradayIV:true,hasPx:true,noWings:false,where:'sweep-capital-policy'}),
    trackCapital:true, recaptureAlternate:true, ...extra};
  let peak=0,avg=0,tot=0,nCred=0,nDeb=0,n=0,cw=0,cs=0,ct=0,sh=0;
  for(const d of days){ const r=runDay5m(d.bars,wrap(v),o); const c=r.capital||{}, L=r.legs||{};
    peak+=c.peakReal||0; avg+=c.avgReal||0; tot+=r.terminal; nCred+=c.nCredit||0; nDeb+=c.nDebitCov||0; n++;
    // LEG UNIQUENESS fallout. Pushing credit share up puts more SHORTS on the shared strikes, which is
    // exactly what makes a later position's ideal legs unavailable. coverWing is the one that matters:
    // a wing-shifted cover locked a GUARANTEED LOSS on 98 of 103 of them (-$136,080), so an arm that buys
    // capital by manufacturing wing-shifts is not buying anything. See leg-ledger.js:95.
    cw+=L.coverWing||0; cs+=L.coverSkip||0; ct+=L.coverTwin||0; sh+=L.shift||0; }
  return { peakReal:peak/n, avgReal:avg/n, total:tot, credShare:100*nCred/((nCred+nDeb)||1),
    coverWing:cw, coverSkip:cs, coverTwin:ct, shift:sh };
}
const ARMS=[];
if(KNOB==='alt'||KNOB==='both') for(const a of [1,2,3,4,6,9999]) ARMS.push({label:`alt=${a===9999?'never':a}`, o:{openAlternateEvery:a}});
if(KNOB==='frac'||KNOB==='both') for(const f of [0.25,0.35,0.50,0.65,0.80]) ARMS.push({label:`frac=${f}`, o:{creditCoverFrac:f}});
// CAPITAL TRIGGER — replaces BOTH hand-set rules. Thresholds are a factor of width x 100 so one setting
// means the same thing at W=10/20/40 (the same reasoning that made stepDollars beat a fixed step count
// on the cover ladder). trig=0 is "always credit", which the user's rule says is NOT the goal: the point
// is to hold deployment near the threshold, not to drive it negative.
// k=0 leaves creditCapitalTrigger falsy, so the engine falls through to the CURRENT hand-set rules —
// that row is the control and is labelled as one rather than as a trigger setting.
if(KNOB==='trig'||KNOB==='both') for(const k of [0,0.25,0.5,0.75,1,1.5,2,3])
  ARMS.push({label: k===0 ? 'CONTROL (today)' : `trig=${k}xW`, o:{creditCapitalTrigger:k}, scale:true});
const agg={};
console.log('variant        arm            peak capital   avg capital        total P&L   credit%  cvrWing  cvrSkip  shift');
for(const v of RUNS){
  for(const a of ARMS){
    const o = a.scale ? { creditCapitalTrigger: a.o.creditCapitalTrigger * (v.spreadWidth || 20) * 100 } : a.o;
    const r=run(v,o);
    console.log(`${v.variant.padEnd(14)} ${a.label.padEnd(14)} ${usd(r.peakReal).padStart(12)} ${usd(r.avgReal).padStart(13)} ${usd(r.total).padStart(16)} ${(r.credShare.toFixed(0)+'%').padStart(8)} ${String(r.coverWing).padStart(8)} ${String(r.coverSkip).padStart(8)} ${String(r.shift).padStart(6)}`);
    const g=agg[a.label]=agg[a.label]||{p:0,a:0,t:0,c:0,n:0,cw:0,cs:0,sh:0};
    g.p+=r.peakReal; g.a+=r.avgReal; g.t+=r.total; g.c+=r.credShare; g.n++; g.cw+=r.coverWing; g.cs+=r.coverSkip; g.sh+=r.shift;
  }
  console.log();
}
console.log('FLEET ROLL-UP');
console.log('arm            peak capital   avg capital        total P&L   credit%  cvrWing  cvrSkip  shift');
for(const k of Object.keys(agg)){ const g=agg[k];
  console.log(`${k.padEnd(14)} ${usd(g.p/g.n).padStart(12)} ${usd(g.a/g.n).padStart(13)} ${usd(g.t).padStart(16)} ${((g.c/g.n).toFixed(0)+'%').padStart(8)} ${String(g.cw).padStart(8)} ${String(g.cs).padStart(8)} ${String(g.sh).padStart(6)}`);
}
