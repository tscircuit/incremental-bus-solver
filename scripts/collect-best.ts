import { resolve,join } from "node:path"
import { am3352SamplePlacements,loadAm3352Sample,am3352Hash } from "../vendor/scripts/am3352-samples"
import { validateAm3352Sample,validateAm3352OutputShape } from "../vendor/scripts/validate-am3352-sample"
import { Store } from "../lib/store"
import { IncumbentLedger } from "../lib/incumbent-ledger"

const taskOutputs=resolve(import.meta.dir,"../.."),ledger=new IncumbentLedger(join(taskOutputs,"best-by-fixture"))
const roots=process.argv.slice(2)
if(!roots.length) throw Error("Pass checkpoint roots or original valid-route export directories; provenance is preserved")
for(const placement of am3352SamplePlacements) {
  const {input,metadata}=await loadAm3352Sample(placement.name)
  for(const root of roots) {
    const directory=resolve(root,placement.name)
    const checkpoint=await Bun.file(join(directory,"current.json")).exists()
    const routeFile=join(resolve(root),placement.name+".json")
    if(!checkpoint&&!await Bun.file(routeFile).exists()) continue
    const state=checkpoint?await new Store(directory).load():null
    const exported=state?null:await Bun.file(routeFile).json()
    if(exported && (exported.sample!==placement.name || exported.solved!==true ||
      exported.failed!==false || am3352Hash(exported.input)!==am3352Hash(input)))
      throw Error("Invalid original route export: "+routeFile)
    const result=await ledger.admit({fixture:placement.name,input,traces:state?.best??exported.traces,
      provenance:state?directory+" step="+state.step:routeFile,
      sourceSearchContract:state?.contract??"upstream-original-valid-route-export"},async traces=>{
      const audit=await validateAm3352Sample(input,metadata,traces)
      validateAm3352OutputShape(input,metadata,traces,exported?.output??{...input,traces:[...(input.traces??[]),...traces]})
      return audit
    })
    console.log(JSON.stringify({fixture:placement.name,source:directory,...result}))
  }
}
