import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { hash, score, compare, UPSTREAM, CONTRACT, type Validator, type Score } from "./refiner"
import type { SimpleRouteJson, Trace } from "../vendor/lib/types"

type Entry={fixture:string;inputHash:string;routeHash:string;score:Score;traces:Trace[];
  upstream:string;contract:string;sourceSearchContract:string;provenance:string;previous:string|null;validation:Awaited<ReturnType<Validator>>}
/** One monotone incumbent per fixture across fresh runs, retained experiments
 * and seeds. Its provenance never turns retained revalidation into fresh data. */
export class IncumbentLedger {
  constructor(readonly root:string) {}
  async admit(request:{fixture:string;input:SimpleRouteJson;traces:Trace[];provenance:string;sourceSearchContract?:string},validate:Validator) {
    if(!/^[a-z0-9-]+$/.test(request.fixture)) throw Error("Invalid fixture identifier")
    const directory=join(this.root,request.fixture)
    await mkdir(join(directory,"records"),{recursive:true})
    const lock=await open(join(directory,"writer.lock"),"wx"); await lock.close()
    try {
      const nextScore=score(request.input,request.traces),inputHash=hash(request.input)
      let previous:string|null=null, prior:Entry|undefined
      try {
        previous=JSON.parse(await readFile(join(directory,"current.json"),"utf8")).record
      } catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error}
      if(previous) {
        prior=JSON.parse(await readFile(join(directory,"records",previous+".json"),"utf8"))
        if(hash(prior)!==previous || prior!.inputHash!==inputHash || hash(prior!.traces)!==prior!.routeHash)
          throw Error("Global incumbent identity mismatch")
      }
      if(prior) {
        const reason=compare(prior.score,nextScore)
        if(reason!=="strict_improvement") return {accepted:false,reason,best:prior.score,candidate:nextScore}
      }
      const validation=await validate(structuredClone(request.traces))
      if(!validation.valid) return {accepted:false,reason:"independent_validation_failed",validation}
      const entry:Entry={fixture:request.fixture,inputHash,routeHash:hash(request.traces),score:nextScore,
        traces:request.traces,upstream:UPSTREAM,contract:CONTRACT,sourceSearchContract:request.sourceSearchContract??CONTRACT,
        provenance:request.provenance,previous,validation}
      const id=hash(entry),file=await open(join(directory,"records",id+".json"),"wx")
      await file.writeFile(JSON.stringify(entry)); await file.sync(); await file.close()
      const records=await open(join(directory,"records"),"r"); await records.sync(); await records.close()
      const pointer=await open(join(directory,"current.json.tmp"),"w")
      await pointer.writeFile(JSON.stringify({record:id,routeHash:entry.routeHash,score:nextScore,provenance:entry.provenance})+"\n")
      await pointer.sync(); await pointer.close(); await rename(join(directory,"current.json.tmp"),join(directory,"current.json"))
      const parent=await open(directory,"r"); await parent.sync(); await parent.close()
      return {accepted:true,reason:prior?"strict_improvement":"initial_valid_solution",best:nextScore,record:id}
    } finally {await rm(join(directory,"writer.lock"))}
  }
}
