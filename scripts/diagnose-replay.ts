import { readFile,writeFile } from "node:fs/promises"
import { resolve,join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Refiner,hash,type Event } from "../lib/refiner"
import { Store } from "../lib/store"
import { loadAm3352Sample } from "../vendor/scripts/am3352-samples"
import { validateAm3352Sample } from "../vendor/scripts/validate-am3352-sample"

const directory=resolve(process.argv[2]),target=Number(process.argv[3]??1103),store=new Store(directory)
const pointer=JSON.parse(await readFile(join(directory,"current.json"),"utf8"))
const decisions=new Map<number,Event>(),audits=new Map<string,NonNullable<Event["violations"]>>()
let id:string|null=pointer.object
while(id) {
  const record=JSON.parse(await readFile(join(directory,"objects",id+".json"),"utf8"))
  if(hash(record)!==id) throw Error("History hash mismatch")
  if(record.event && record.state.step<=target) {
    decisions.set(record.state.step,record.event)
    if(record.event.violations)audits.set(record.event.candidateHash,record.event.violations)
  }
  id=record.previous
}
const saved=await store.loadAt(target),anchor=await Bun.file(join(directory,"anchor.json")).json()
const {input,metadata}=await loadAm3352Sample("control")
if(!(await validateAm3352Sample(input,metadata,saved.best)).valid) throw Error("Saved best invalid")
const replay=await Refiner.create(input,anchor.traces,anchor.seed,async traces=>{
  if(hash(traces)===hash(anchor.traces))return validateAm3352Sample(input,metadata,traces)
  const audit=audits.get(hash(traces))
  if(!audit)throw Error("Replay requested an unrecorded candidate audit: "+hash(traces))
  return audit
})
let firstDecisionDifference:number|null=null
for(let step=1;step<=target;step++) {
  const actual=(await replay.step()).event,expected=decisions.get(step)
  if(!isDeepStrictEqual(JSON.parse(JSON.stringify(actual)),expected)) {
    firstDecisionDifference=step
    await writeFile(join(directory,"replay-decision-difference.json"),JSON.stringify({step,actual,expected},null,2))
    break
  }
}
const normalized=JSON.parse(JSON.stringify(replay.state))
const result={target,firstDecisionDifference,exactMemoryState:isDeepStrictEqual(replay.state,saved),
  serializedStateIdentical:isDeepStrictEqual(normalized,saved),bestHashIdentical:replay.state.bestHash===saved.bestHash,
  differingMemoryFields:Object.keys(saved).filter(k=>!isDeepStrictEqual(replay.state[k as keyof typeof saved],saved[k as keyof typeof saved])),
  auditMode:"recorded immutable audits for diagnostic replay; saved final best freshly independently revalidated"}
await writeFile(join(directory,"replay-diagnosis.json"),JSON.stringify(result,null,2))
console.log(JSON.stringify(result))
