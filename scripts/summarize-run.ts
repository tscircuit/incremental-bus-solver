import { resolve,join,basename } from "node:path"
import { readFile,writeFile } from "node:fs/promises"
import { hash,compare,type State } from "../lib/refiner"
import { Store } from "../lib/store"
import { loadAm3352Sample,am3352SamplePlacements } from "../vendor/scripts/am3352-samples"

const directory=resolve(process.argv[2]),state=await new Store(directory).load()
const anchor=await Bun.file(join(directory,"anchor.json")).json()
const sample=am3352SamplePlacements.find(p=>p.name===basename(directory))
const names=sample?(await loadAm3352Sample(sample.name)).metadata.signalNames:{}
const counts:Record<string,number>={},violationCounts:Record<string,number>={},accepted:unknown[]=[]
const pointer=JSON.parse(await readFile(join(directory,"current.json"),"utf8"))
let id:string|null=pointer.object
let newer:Omit<State,"best">|null=null,verifiedStates=0
while(id) {
  const record=JSON.parse(await readFile(join(directory,"objects",id+".json"),"utf8"))
  if(hash(record)!==id)throw Error("History hash mismatch")
  const current=record.state as Omit<State,"best">
  if(newer) {
    if(newer.step!==current.step+1 || newer.runId!==current.runId || newer.inputHash!==current.inputHash)
      throw Error("Discontinuous search history")
    if(newer.bestHash===current.bestHash) {
      if(hash(newer.bestScore)!==hash(current.bestScore))throw Error("Score changed for identical copper")
    } else if(compare(current.bestScore,newer.bestScore)!=="strict_improvement")
      throw Error("Saved incumbent regression or plateau replacement")
  }
  const event=record.event
  if(event) {
    if(event.stepId!==current.step || event.incumbentAfter!==current.bestHash ||
      (event.accepted && (!event.violations?.valid || event.reason!=="strict_improvement")))
      throw Error("Decision disagrees with its committed state or validation")
    counts[event.reason]=(counts[event.reason]??0)+1
    for(const issue of event.violations?.combinedDrc?.issues??[]) {
      const reason=issue.type??issue.code??issue.message??"unclassified_copper_issue"
      violationCounts[reason]=(violationCounts[reason]??0)+1
    }
    if(event.accepted) {
      const connection=anchor.traces[event.proposal.trace].connection_name
      accepted.push({step:event.stepId,connection,signal:names[connection]??connection,
        copperReductionMm:event.before.copperMm-event.candidateScore.copperMm,
        turnReduction:event.before.turns-event.candidateScore.turns,
        shortJogReduction:event.before.shortJogs-event.candidateScore.shortJogs,bestHash:event.incumbentAfter})
    }
  }
  newer=current;verifiedStates++
  id=record.previous
}
if(newer?.step!==0 || verifiedStates!==state.step+1)throw Error("Incomplete search history")
const summary={runId:state.runId,upstream:state.upstream,contract:state.contract,steps:state.step,
  best:state.bestScore,bestHash:state.bestHash,queueRemaining:state.queue.length,
  verifiedHistoryStates:verifiedStates,decisions:counts,violationCounts,accepted:accepted.reverse()}
await writeFile(join(directory,"summary.json"),JSON.stringify(summary,null,2))
console.log(JSON.stringify(summary,null,2))
