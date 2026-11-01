import { resolve,join } from "node:path"
import { writeFile,rename } from "node:fs/promises"
import { am3352SamplePlacements,loadAm3352Sample } from "../vendor/scripts/am3352-samples"
import { validateAm3352Sample,validateAm3352OutputShape } from "../vendor/scripts/validate-am3352-sample"
import { hash,score,UPSTREAM,CONTRACT } from "../lib/refiner"

const root=resolve(process.argv[2]??resolve(import.meta.dir,"../../best-by-fixture"))
const results=[]
for(const placement of am3352SamplePlacements) {
  const directory=join(root,placement.name),pointer=await Bun.file(join(directory,"current.json")).json()
  if(!/^[a-f0-9]{64}$/.test(pointer.record))throw Error("Invalid ledger pointer")
  const entry=await Bun.file(join(directory,"records",pointer.record+".json")).json()
  const {input,metadata}=await loadAm3352Sample(placement.name)
  if(hash(entry)!==pointer.record || entry.fixture!==placement.name || entry.inputHash!==hash(input) ||
    entry.upstream!==UPSTREAM || entry.contract!==CONTRACT || entry.routeHash!==hash(entry.traces) ||
    hash(entry.score)!==hash(score(input,entry.traces)))throw Error("Ledger identity/score mismatch: "+placement.name)
  const audit=await validateAm3352Sample(input,metadata,entry.traces)
  validateAm3352OutputShape(input,metadata,entry.traces,{...input,traces:[...(input.traces??[]),...entry.traces]})
  if(!audit.valid || audit.busLengths.some(bus=>!bus.aboveMinimumLength||!bus.withinLengthLimit))
    throw Error("Ledger independent validation failed: "+placement.name)
  results.push({sample:placement.name,valid:true,record:pointer.record,routeHash:entry.routeHash,
    score:entry.score,provenance:entry.provenance,sourceSearchContract:entry.sourceSearchContract??null})
  console.log(JSON.stringify(results.at(-1)))
}
const file=join(root,"audit.json")
await writeFile(file+".tmp",JSON.stringify({upstream:UPSTREAM,createdAtUtc:new Date().toISOString(),results},null,2)+"\n")
await rename(file+".tmp",file)
