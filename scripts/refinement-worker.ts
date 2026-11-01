import { join } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { am3352SamplePlacements, loadAm3352Sample } from "../vendor/scripts/am3352-samples"
import { validateAm3352Sample, validateAm3352OutputShape } from "../vendor/scripts/validate-am3352-sample"
import { Refiner, hash } from "../lib/refiner"
import { Store } from "../lib/store"

const request=await Bun.file(process.argv[2]).json()
let fixture:Awaited<ReturnType<typeof loadAm3352Sample>>|undefined
for(const placement of am3352SamplePlacements) {
  const loaded=await loadAm3352Sample(placement.name)
  if(hash(loaded.input)===hash(request.input)) {fixture=loaded; break}
}
if(!fixture) throw Error("Input does not match any pinned native fixture")
const {input,metadata}=fixture, inputHash=hash(input)
const validate=async (traces:Parameters<typeof validateAm3352OutputShape>[2]) => {
  if(hash(input)!==inputHash) throw Error("Immutable input changed")
  const audit=await validateAm3352Sample(input,metadata,traces)
  validateAm3352OutputShape(input,metadata,traces,{...input,traces:[...(input.traces??[]),...traces]})
  return audit
}
const store=new Store(join(request.root,metadata.name)), release=await store.lock()
try {
  if(await Bun.file(join(store.directory,"current.json")).exists()) throw Error("Fresh worker refuses prior search state")
  const refiner=await Refiner.create(input,request.traces,request.seed,validate)
  await writeFile(join(store.directory,"anchor.json"),JSON.stringify({input,traces:request.traces,seed:request.seed,
    provenance:"fresh official benchmark worker"}))
  await store.commit(refiner.state,null)
  const start=performance.now()
  for(let i=0;i<request.steps && performance.now()-start<request.seconds*1000;i++) {
    const {event,candidate}=await refiner.step()
    await store.commit(refiner.state,event,candidate)
    const {violations,...decision}=event
    console.log(`duration=${((performance.now()-start)/1000).toFixed(3)}s `+JSON.stringify({...decision,
      validation:violations && {valid:violations.valid,issues:violations.issues}}))
    if(!refiner.state.queue.length) break
  }
  const audit=await validate(refiner.state.best)
  if(!audit.valid) throw Error("Final incumbent failed independent audit")
  await writeFile(request.result,JSON.stringify({inputHash,bestHash:refiner.state.bestHash,traces:refiner.state.best,
    stats:{steps:refiner.state.step,accepted:refiner.state.accepted,rejected:refiner.state.rejected,
      score:refiner.state.bestScore,queueRemaining:refiner.state.queue.length,refinementMilliseconds:performance.now()-start}}))
} finally {await release()}
