import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { BusLanesPipelineSolver } from "../vendor/lib/bus-lanes-pipeline-solver"
import { am3352SamplePlacements, loadAm3352Sample } from "../vendor/scripts/am3352-samples"
import { validateAm3352Sample, validateAm3352OutputShape } from "../vendor/scripts/validate-am3352-sample"
import { Refiner, hash, score, UPSTREAM, CONTRACT, type Audit, type Event } from "./refiner"
import { Store, checkpointStatesEqual } from "./store"
import { snapshot } from "./snapshot"

const args = process.argv.slice(2), command = args[0] ?? "help"
function option(key:string,fallback?:string) {
  const i = args.indexOf(key)
  if (i < 0) return fallback
  if (!args[i+1] || args[i+1].startsWith("--")) throw Error("Missing value for "+key)
  return args[i+1]
}
const directory = resolve(option("--directory","../runs")!)
const seed = Number(option("--seed","61")), steps = Number(option("--steps","128"))
if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(steps) || steps < 0) throw Error("Invalid seed/steps")
const timeout = Number(option("--timeout-seconds","3600"))
if (!Number.isFinite(timeout) || timeout <= 0) throw Error("Invalid timeout")
const sampleName = option("--sample")
if (sampleName && !am3352SamplePlacements.some(p => p.name === sampleName)) throw Error("Unknown sample")

async function context(name:string) {
  const {input,metadata} = await loadAm3352Sample(name as typeof am3352SamplePlacements[number]["name"])
  const inputHash = hash(input)
  const validate = async (traces: Parameters<typeof validateAm3352Sample>[2]): Promise<Audit> => {
    if (hash(input) !== inputHash) throw Error("Immutable input changed")
    const report = await validateAm3352Sample(input,metadata,traces)
    if (traces) validateAm3352OutputShape(input,metadata,traces,{...input,traces:[...(input.traces??[]),...traces]})
    return report
  }
  return {input,metadata,validate}
}
async function advance(refiner:Refiner,store:Store,deadline=performance.now()+timeout*1000) {
  const start = performance.now()
  for (let i=0; i<steps; i++) {
    if(performance.now() >= deadline) break
    const {event,candidate} = await refiner.step()
    await store.commit(refiner.state,event,candidate)
    console.log(`duration=${((performance.now()-start)/1000).toFixed(3)}s `+JSON.stringify({sample:store.directory,...event,proposal:event.proposal && {
      trace:event.proposal.trace,start:event.proposal.start,end:event.proposal.end,key:event.proposal.key},violations:event.violations && {
      valid:event.violations.valid,issues:event.violations.issues}}))
    if (!refiner.state.queue.length) break
    if (performance.now()-start > timeout*1000) break
  }
}
if (command === "fresh") {
  await mkdir(directory,{recursive:true})
  const reportPath = join(directory,"fresh-report.json")
  if (await Bun.file(reportPath).exists()) throw Error("Fresh report exists: use a new directory")
  const reports: unknown[] = []
  for (const placement of am3352SamplePlacements.filter(p => !sampleName || p.name === sampleName)) {
    const start = performance.now(), {input,metadata,validate} = await context(placement.name)
    const store = new Store(join(directory,placement.name)), unlock = await store.lock()
    try {
      if (await Bun.file(join(store.directory,"current.json")).exists()) throw Error("Refusing to overwrite prior run; use resume")
      const audit = await validate(undefined)
      if (!audit.valid) throw Error("Input/fixed-copper audit failed")
      const solver = new BusLanesPipelineSolver(input,{singleCarrier:{fixedConnections:metadata.powerConnections}})
      let last = performance.now()
      while (!solver.solved && !solver.failed && performance.now()-start < timeout*1000) {
        solver.step()
        if (performance.now()-last > 10000) {
          console.log(JSON.stringify({sample:placement.name,phase:solver.phase,step:solver.iterations,
            routed:solver.traces.length,elapsedMs:performance.now()-start}))
          last = performance.now()
        }
      }
      if (!solver.solved || performance.now()-start >= timeout*1000) {
        await writeFile(join(store.directory,"infeasible.json"),JSON.stringify({input,traces:solver.traces,
          phase:solver.phase,error:solver.error,failureCode:solver.failureCode}))
        reports.push({sample:placement.name,status:solver.failed?"failed":"timed_out",solved:false,
          requestedSignals:input.connections.length,routedSignals:solver.traces.length,error:solver.error,
          milliseconds:performance.now()-start})
      } else {
        const validation = await validate(solver.traces)
        if (!validation.valid) throw Error("Fresh solve failed independent validation")
        const initialScore = score(input,solver.traces)
        const refiner = await Refiner.create(input,solver.traces,seed,validate)
        await writeFile(join(store.directory,"anchor.json"),JSON.stringify({input,metadata,traces:solver.traces,seed}))
        await store.commit(refiner.state,null)
        await advance(refiner,store,start+timeout*1000)
        const finalValidation = await validate(refiner.state.best)
        reports.push({sample:placement.name,status:"solved",solved:true,requestedSignals:input.connections.length,
          routedSignals:refiner.state.best.length,initialScore,score:refiner.state.bestScore,
          bestHash:refiner.state.bestHash,accepted:refiner.state.accepted,rejected:refiner.state.rejected,
          validation:finalValidation,milliseconds:performance.now()-start})
      }
    } catch(error) {
      reports.push({sample:placement.name,status:"validation_failed",solved:false,error:String(error),milliseconds:performance.now()-start})
    } finally { await unlock() }
    await writeFile(reportPath,JSON.stringify({upstream:UPSTREAM,contract:CONTRACT,seed,steps,timeoutSeconds:timeout,
      runtime:Bun.version,architecture:process.arch,reports},null,2))
  }
  console.log(`duration=${(reports.map(r=>(r as {milliseconds:number}).milliseconds).reduce((sum,ms)=>sum+ms,0)/1000).toFixed(3)}s solved=${reports.filter(r=>(r as {solved:boolean}).solved).length}/${reports.length}`)
  if(reports.some(r=>(r as {status:string}).status==="validation_failed")) process.exitCode=1
} else if (command === "resume") {
  if (!sampleName) throw Error("--sample required")
  const store = new Store(join(directory,sampleName)), unlock = await store.lock()
  try {
    const {input,validate} = await context(sampleName)
    const refiner = await Refiner.restore(input,await store.load(),validate)
    await advance(refiner,store)
  } finally { await unlock() }
} else if (command === "inspect") {
  if (!sampleName) throw Error("--sample required")
  const state = await new Store(join(directory,sampleName)).load()
  console.log(JSON.stringify({...state,best:undefined,queue:state.queue.length,seen:state.seen.length},null,2))
} else if (command === "snapshot") {
  if (!sampleName) throw Error("--sample required")
  const store=new Store(join(directory,sampleName)), state=await store.load()
  const {input,validate}=await context(sampleName), candidate=option("--candidate")
  let traces=state.best, label="VALIDATED BEST "+state.bestHash
  if(candidate) {
    if(!/^[a-f0-9]{64}$/.test(candidate)) throw Error("Invalid candidate hash")
    const record=await Bun.file(join(store.directory,"candidates",candidate+".json")).json()
    traces=await Bun.file(join(store.directory,"routes",record.baseBestHash+".json")).json()
    traces[record.traceIndex]=record.trace
    if(hash(traces)!==candidate) throw Error("Candidate snapshot hash mismatch")
    label="EXPLORATORY CANDIDATE: "+record.event.reason+" "+candidate
  } else if (!(await validate(traces)).valid) throw Error("Best failed revalidation")
  const path=resolve(option("--output",join(store.directory,candidate?candidate+".svg":"best.svg"))!)
  await writeFile(path,snapshot(input,traces,label)); console.log(path)
} else if (command === "replay") {
  if (!sampleName) throw Error("--sample required")
  const store = new Store(join(directory,sampleName)), selectedStep=option("--step")
  const saved=selectedStep===undefined?await store.load():await store.loadAt(Number(selectedStep))
  const anchor = await Bun.file(join(store.directory,"anchor.json")).json()
  const {input,validate} = await context(sampleName)
  const replay = await Refiner.create(input,anchor.traces,anchor.seed,validate)
  for (let i=0;i<saved.step;i++) await replay.step()
  // Store reconstruction reorders object properties. Compare semantic state;
  // route/decision hashes remain exact and are checked separately.
  if (!checkpointStatesEqual(replay.state,saved)) throw Error("Replay diverged")
  console.log(JSON.stringify({replay:"identical",steps:saved.step,best:saved.bestHash}))
} else if (command === "import") {
  // Retained-output experiments are explicitly separate from fresh performance.
  const path = option("--routes")
  if (!sampleName || !path) throw Error("--sample and --routes required")
  const retained = await Bun.file(path).json(), {input,validate} = await context(sampleName)
  if (hash(retained.input) !== hash(input)) throw Error("Retained input mismatch")
  const store = new Store(join(directory,sampleName)), unlock = await store.lock()
  try {
    if (await Bun.file(join(store.directory,"current.json")).exists()) throw Error("Use resume")
    const refiner = await Refiner.create(input,retained.traces,seed,validate)
    await writeFile(join(store.directory,"anchor.json"),JSON.stringify({input,traces:retained.traces,seed,provenance:"retained-output revalidation"}))
    await store.commit(refiner.state,null); await advance(refiner,store)
  } finally { await unlock() }
} else {
  console.log("fresh | import --sample NAME --routes FILE | resume --sample NAME | inspect --sample NAME | replay --sample NAME\nOptions: --directory DIR --seed 61 --steps 128 --timeout-seconds 3600")
}
