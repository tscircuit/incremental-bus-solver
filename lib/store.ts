import { mkdir, readFile, rename, writeFile, open, rm } from "node:fs/promises"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { hash, compare, type State, type Event } from "./refiner"

/** The checkpoint protocol is JSON: absent/undefined properties and signed
 * zero normalize on disk. Routing decisions and hashes are still exact. */
export const checkpointStatesEqual=(a:State,b:State)=>isDeepStrictEqual(
  JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)))

/** Immutable content-addressed objects + one atomic pointer. The session state
 * includes its best, search queue and last event, so a crash cannot advance the
 * search without retaining the corresponding decision. History is append-only. */
export class Store {
  constructor(readonly directory: string) {}
  async lock() {
    await mkdir(this.directory,{recursive:true})
    const path = join(this.directory,"writer.lock")
    const file = await open(path,"wx")
    await file.writeFile(JSON.stringify({pid:process.pid,created:new Date().toISOString()}))
    await file.close()
    return async () => { await rm(path) }
  }
  async load(): Promise<State> {
    const pointer = JSON.parse(await readFile(join(this.directory,"current.json"),"utf8"))
    const object = JSON.parse(await readFile(join(this.directory,"objects",pointer.object+".json"),"utf8"))
    if (hash(object) !== pointer.object) throw Error("Checkpoint object hash mismatch")
    const best = JSON.parse(await readFile(join(this.directory,"routes",object.state.bestHash+".json"),"utf8"))
    if (hash(best) !== object.state.bestHash) throw Error("Incumbent route hash mismatch")
    return {...object.state,best}
  }
  async loadAt(step:number):Promise<State> {
    const pointer=JSON.parse(await readFile(join(this.directory,"current.json"),"utf8"))
    let id:string|null=pointer.object
    while(id) {
      const record=JSON.parse(await readFile(join(this.directory,"objects",id+".json"),"utf8"))
      if(hash(record)!==id) throw Error("History object hash mismatch")
      if(record.state.step===step) {
        const best=JSON.parse(await readFile(join(this.directory,"routes",record.state.bestHash+".json"),"utf8"))
        if(hash(best)!==record.state.bestHash) throw Error("History route hash mismatch")
        return {...record.state,best}
      }
      id=record.previous
    }
    throw Error("Step is not present in saved history")
  }
  async commit(state: State,event: Event | null, candidate: unknown = null) {
    await mkdir(join(this.directory,"objects"),{recursive:true})
    await mkdir(join(this.directory,"routes"),{recursive:true})
    await this.immutable(join(this.directory,"routes",state.bestHash+".json"),JSON.stringify(state.best))
    let previous: string | null = null
    let priorPointer:{object:string}|undefined
    try {
      priorPointer = JSON.parse(await readFile(join(this.directory,"current.json"),"utf8"))
    } catch(error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    if(priorPointer) {
      const prior = await this.load()
      if (state.runId !== prior.runId || state.inputHash !== prior.inputHash || state.step <= prior.step)
        throw Error("Refusing to replace existing run or rewind search")
      if (state.bestHash !== prior.bestHash && compare(prior.bestScore,state.bestScore) !== "strict_improvement")
        throw Error("Refusing to worsen or replace incumbent on a plateau")
      previous = priorPointer.object
    }
    const {best,...searchState}=state
    const object = {state:searchState,event,previous}, id = hash(object)
    await this.immutable(join(this.directory,"objects",id+".json"),JSON.stringify(object))
    const objects = await open(join(this.directory,"objects"),"r"); await objects.sync(); await objects.close()
    if (candidate !== null && event?.candidateHash) {
      await mkdir(join(this.directory,"candidates"),{recursive:true})
      const traces=candidate as State["best"]
      await this.firstCandidateSnapshot(join(this.directory,"candidates",event.candidateHash+".json"),JSON.stringify({event,
        baseBestHash:event.incumbentBefore,traceIndex:event.proposal?.trace,trace:event.proposal?traces[event.proposal.trace]:null}))
    }
    const pointer = join(this.directory,"current.json"), temporary = pointer+".tmp"
    const routeDirectory=await open(join(this.directory,"routes"),"r"); await routeDirectory.sync(); await routeDirectory.close()
    const file = await open(temporary,"w")
    await file.writeFile(JSON.stringify({object:id,best:state.bestHash,step:state.step,score:state.bestScore})+"\n")
    await file.sync(); await file.close(); await rename(temporary,pointer)
    // Directory fsync preserves pointer rename across host crashes on Linux.
    const dir = await open(this.directory,"r"); await dir.sync(); await dir.close()
  }
  private async immutable(path:string,content:string) {
    try {
      const f = await open(path,"wx"); await f.writeFile(content); await f.sync(); await f.close()
    } catch(error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if(await readFile(path,"utf8")!==content) throw Error("Immutable checkpoint content mismatch")
    }
  }
  private async firstCandidateSnapshot(path:string,content:string) {
    // Different local windows can produce the same complete route. Their
    // decisions remain in history; the geometry needs only its first snapshot.
    try {
      const file=await open(path,"wx"); await file.writeFile(content); await file.sync(); await file.close()
    } catch(error) {if((error as NodeJS.ErrnoException).code!=="EEXIST") throw error}
  }
}
