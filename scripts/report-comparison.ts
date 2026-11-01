import { resolve,join } from "node:path"
import { writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { am3352SamplePlacements,loadAm3352Sample,am3352Hash } from "../vendor/scripts/am3352-samples"
import { validateAm3352Sample,validateAm3352OutputShape } from "../vendor/scripts/validate-am3352-sample"
import { compare,score,UPSTREAM,type Score } from "../lib/refiner"
import { Store } from "../lib/store"
import { hostname } from "node:os"

const args=process.argv.slice(2)
const argument=(name:string,fallback:string)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1]}
const outputs=resolve(argument("--artifacts",resolve(import.meta.dir,"../..")))
const basePath=resolve(argument("--base",join(outputs,"baseline-clean.json")))
const headPath=resolve(argument("--head",join(outputs,"new-final-clean.json")))
const prefix=resolve(argument("--output",join(outputs,"comparison")))
type Audit=Awaited<ReturnType<typeof validateAm3352Sample>>
type Report={sample:string;solved:boolean;status:string;requestedSignals:number;routedSignals:number;
  solveMilliseconds:number;milliseconds:number;inputUnchanged:boolean;fixedPowerPreserved:boolean;
  inputSha256:string|null;error:string|null;validation:Audit|null;[key:string]:unknown}

async function ready(path:string):Promise<Report[]|null> {
  try {
    const rows=await Bun.file(path).json()
    return Array.isArray(rows)&&rows.length===am3352SamplePlacements.length?rows:null
  }catch{return null}
}
let base:Report[]|null=null,head:Report[]|null=null
do {
  base=await ready(basePath);head=await ready(headPath)
  if(!base||!head) {
    if(!args.includes("--wait")&&args.includes("--head"))throw Error("Both complete eleven-case reports are required")
    await Bun.sleep(10000)
  }
}while(!base||!head)

function reportScore(row:Report):Score|null {
  const quality=row.validation?.quality
  if(!row.solved||!quality)return null
  return {areaMm2:quality.footprint.bounds?.areaMm2??0,copperMm:quality.totalPlanarLengthMm,
    turns:quality.ordinaryTurns,shortJogs:quality.shortJogs,maxDetour:quality.maxDetourRatio??0}
}
const difference=(before:Score,after:Score)=>Object.fromEntries(Object.keys(before).map(key=>{
  const k=key as keyof Score;return [key,after[k]-before[k]]
}))
function percentile(seconds:number[],q:number) {
  const sorted=[...seconds].sort((a,b)=>a-b),position=(sorted.length-1)*q,index=Math.floor(position)
  return sorted[index]+(sorted[Math.ceil(position)]-sorted[index])*(position-index)
}
function summary(rows:Report[]) {
  const seconds=rows.map(row=>(row.solveMilliseconds>0?row.solveMilliseconds:row.milliseconds)/1000)
  const workerSeconds=rows.map(row=>row.milliseconds/1000)
  const distribution=(values:number[])=>({sum:values.reduce((a,b)=>a+b,0),
    mean:values.reduce((a,b)=>a+b,0)/values.length,p50:percentile(values,0.5),p95:percentile(values,0.95)})
  return {solved:rows.filter(r=>r.solved).length,total:rows.length,
    failures:rows.filter(r=>!r.solved).map(r=>({sample:r.sample,status:r.status,error:r.error})),
    runtimeSeconds:distribution(seconds),workerRuntimeSeconds:distribution(workerSeconds),
    validatedSignalCount:rows.filter(r=>r.solved).reduce((sum,row)=>sum+row.routedSignals,0)}
}
const cases:Record<string,unknown>[]=[]
for(const placement of am3352SamplePlacements) {
  const before=base.filter(row=>row.sample===placement.name),after=head.filter(row=>row.sample===placement.name)
  if(before.length!==1||after.length!==1)throw Error("Missing or duplicate case: "+placement.name)
  const {input,metadata}=await loadAm3352Sample(placement.name)
  const controlRerun=placement.name==="control"&&Boolean(after[0]._persistenceRevisionRerun)
  const headRoot=join(outputs,controlRerun?"official-final-control-rerun":"official-final")
  const requestRoot=join(headRoot,"requests"),requestId=am3352Hash(input)
  const failurePath=join(requestRoot,requestId+".failure.json")
  const fallback=await Bun.file(failurePath).exists()?await Bun.file(failurePath).json():null
  const stateRoot=join(headRoot,placement.name)
  const state=await Bun.file(join(stateRoot,"current.json")).exists()?await new Store(stateRoot).load():null
  const anchor=state?await Bun.file(join(stateRoot,"anchor.json")).json():null
  if(state && (am3352Hash(anchor.traces)!==state.anchorHash || am3352Hash(anchor.input)!==am3352Hash(input)))
    throw Error("Initial route anchor mismatch: "+placement.name)
  const initialRoutingScore=state?score(input,anchor.traces):null
  if(state && initialRoutingScore && Object.keys(initialRoutingScore).some(key=>{
    const k=key as keyof Score;return state.bestScore[k]>initialRoutingScore[k]
  }))throw Error("Refinement worsened its own validated initial route")
  for(const [side,row] of [["base",before[0]],["head",after[0]]] as const) {
    if(!row.solved)continue
    if(row.requestedSignals!==47||row.routedSignals!==47||!row.inputUnchanged||!row.fixedPowerPreserved||
      row.inputSha256!==am3352Hash(input)||!row.validation?.valid||!row.validation.complete||!row.validation.matched||
      !row.validation.fixedDrc.valid||!row.validation.combinedDrc?.valid)throw Error("Invalid completed report: "+side+" "+placement.name)
    const candidates=side==="base"?[join(outputs,"baseline-reruns/valid-routes",placement.name+".json"),join(outputs,"baseline-routes",placement.name+".json")]:
      [join(outputs,controlRerun?"new-final-control-routes":"new-final-routes",placement.name+".json")]
    const routePath=(await Promise.all(candidates.map(async path=>(await Bun.file(path).exists())?path:null))).find(Boolean)
    if(!routePath)throw Error("Missing completed-route artifact: "+side+" "+placement.name)
    const retained=await Bun.file(routePath).json()
    if(am3352Hash(retained.input)!==am3352Hash(input))throw Error("Route artifact input mismatch")
    const audit=await validateAm3352Sample(input,metadata,retained.traces)
    validateAm3352OutputShape(input,metadata,retained.traces,retained.output)
    if(!audit.valid)throw Error("Final independent artifact revalidation failed: "+side+" "+placement.name)
    if(side==="head" && state && !fallback && am3352Hash(retained.traces)!==state.bestHash)
      throw Error("Returned route does not match the saved incumbent: "+placement.name)
    if(audit.busLengths.some(bus=>!bus.aboveMinimumLength||!bus.withinLengthLimit))
      throw Error("Declared absolute bus length bounds failed: "+side+" "+placement.name)
    const originalScore=reportScore(row),verifiedScore=reportScore({...row,validation:audit})
    if(!originalScore||!verifiedScore||Object.keys(originalScore).some(key=>{
      const k=key as keyof Score;return originalScore[k]!==verifiedScore[k]
    }))throw Error("Artifact score differs from the original worker report: "+side+" "+placement.name)
  }
  const baselineScore=reportScore(before[0]),headScore=reportScore(after[0])
  cases.push({sample:placement.name,baseline:before[0],head:after[0],baselineScore,headScore,
    initialRoutingScore,
    initialRoutingDelta:baselineScore&&initialRoutingScore?difference(baselineScore,initialRoutingScore):null,
    refinementDelta:initialRoutingScore&&headScore&&!fallback?difference(initialRoutingScore,headScore):null,
    headRefinement:{fallback,checkpoint:state?{directory:stateRoot,runId:state.runId,steps:state.step,
      accepted:state.accepted,rejected:state.rejected,queueRemaining:state.queue.length,
      bestHash:state.bestHash,contract:state.contract}:null},
    scoreRelation:baselineScore&&headScore?compare(baselineScore,headScore):"not_comparable",
    delta:baselineScore&&headScore?difference(baselineScore,headScore):null})
}
const infrastructure=await Bun.file(join(outputs,"infrastructure-failures.json")).exists()?await Bun.file(join(outputs,"infrastructure-failures.json")).json():[]
const additiveDeltas=(field:string)=>Object.fromEntries(["copperMm","turns","shortJogs"].map(key=>[
  key,cases.reduce((sum,row)=>sum+((row[field] as Record<string,number>|null)?.[key]??0),0)]))
const searches=cases.map(row=>(row.headRefinement as {checkpoint:{steps:number;accepted:number;rejected:number}|null}).checkpoint)
const qualityChanges={
  casesByRelation:cases.reduce<Record<string,number>>((counts,row)=>{
    const relation=String(row.scoreRelation);counts[relation]=(counts[relation]??0)+1;return counts
  },{} as Record<string,number>),
  baselineToFinal:additiveDeltas("delta"),initialRoutingVariation:additiveDeltas("initialRoutingDelta"),
  incrementalEdits:{additiveDelta:additiveDeltas("refinementDelta"),
    casesWithAcceptedEdits:searches.filter(state=>state&&state.accepted>0).length,
    accepted:searches.reduce((sum,state)=>sum+(state?.accepted??0),0),
    rejected:searches.reduce((sum,state)=>sum+(state?.rejected??0),0),
    steps:searches.reduce((sum,state)=>sum+(state?.steps??0),0)}}
const measuredEngine=await Bun.file(join(outputs,"measured-engine.json")).json()
for(const [path,expected] of Object.entries(measuredEngine.modules)) {
  const actual=createHash("sha256").update(new Uint8Array(await Bun.file(resolve(import.meta.dir,"..",path)).arrayBuffer())).digest("hex")
  if(actual!==expected)throw Error("Measured worker code changed: "+path)
}
const report={upstream:UPSTREAM,baselineReport:basePath,headReport:headPath,
  createdAtUtc:new Date().toISOString(),baseline:summary(base),head:summary(head),qualityChanges,cases,infrastructure,measuredEngine,
  implementationFallbacks:cases.filter(row=>(row.headRefinement as {fallback:unknown}).fallback)
    .map(row=>({sample:row.sample,...row.headRefinement as object})),
  method:{caseCount:11,requiredSignalsPerCase:47,immutablePowerDogbonesPerCase:161,timeoutSeconds:3600,
    runtime:"Bun "+Bun.version,host:hostname(),architecture:process.arch,
    scoring:"Original upstream solved/validation and quality metrics; no upstream scalar score exists. Pareto relation is an additional disclosed ordering.",
    attribution:"Fresh initial routes can vary under upstream time-bounded search. initialRoutingDelta separates that variation from refinementDelta, measured against the hash-bound validated anchor. Overall delta remains the actual baseline versus final result.",
    artifactValidation:"Every reported completed route freshly revalidated with the original independent validator and output-shape check.",
    timing:"runtimeSeconds uses original solveMilliseconds, including refinement. workerRuntimeSeconds also includes fixture loading and independent validation. Host contention and subsequent serialization varied; no speedup claim. Percentiles use linear interpolation.",
    reruns:"Any prior infrastructure or persistence-version reruns are retained in the original per-case report metadata. Never choose best-of-repeat measurements. Fixtures, runtime, checks and 3600s budget remain unchanged."}}
await writeFile(prefix+".json",JSON.stringify(report,null,2))
const csv=["sample,baseline_status,head_status,base_area_mm2,head_area_mm2,base_copper_mm,head_copper_mm,base_turns,head_turns,base_short_jogs,head_short_jogs,base_max_detour,head_max_detour,base_solve_seconds,head_solve_seconds,base_worker_seconds,head_worker_seconds,relation,head_initial_area_mm2,head_initial_copper_mm,head_initial_turns,head_initial_short_jogs,head_initial_max_detour,refinement_copper_delta_mm,refinement_turn_delta,refinement_short_jog_delta"]
for(const row of cases) {
  const b=row.baseline as Report,h=row.head as Report,bs=row.baselineScore as Score|null,hs=row.headScore as Score|null
  const initial=row.initialRoutingScore as Score|null,local=row.refinementDelta as Record<string,number>|null
  csv.push([row.sample,b.status,h.status,bs?.areaMm2,hs?.areaMm2,bs?.copperMm,hs?.copperMm,bs?.turns,hs?.turns,
    bs?.shortJogs,hs?.shortJogs,bs?.maxDetour,hs?.maxDetour,
    (b.solveMilliseconds>0?b.solveMilliseconds:b.milliseconds)/1000,
    (h.solveMilliseconds>0?h.solveMilliseconds:h.milliseconds)/1000,
    b.milliseconds/1000,h.milliseconds/1000,row.scoreRelation,initial?.areaMm2,initial?.copperMm,
    initial?.turns,initial?.shortJogs,initial?.maxDetour,local?.copperMm,local?.turns,local?.shortJogs]
    .map(x=>JSON.stringify(x??"")).join(","))
}
await writeFile(prefix+".csv",csv.join("\n")+"\n")
console.log(JSON.stringify({baseline:report.baseline,head:report.head,report:prefix+".json",csv:prefix+".csv"}))
