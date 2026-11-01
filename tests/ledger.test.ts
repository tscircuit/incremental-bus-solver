import { expect,test } from "bun:test"
import { mkdtemp,rm,readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { IncumbentLedger } from "../lib/incumbent-ledger"
import { BusLanesSolver } from "../vendor/lib/bus-lanes-solver"
import type { SimpleRouteJson,Trace,Wire } from "../vendor/lib/types"
const wire=(x:number,y:number):Wire=>({x,y,layer:"top",width:0.1,route_type:"wire"})
test("global incumbent survives worse fresh runs and rejects missing-net shortcuts",async()=>{
  const root=await mkdtemp(join(tmpdir(),"bus-ledger-")), ledger=new IncumbentLedger(root)
  const input:SimpleRouteJson={layerCount:2,minTraceWidth:0.1,obstacles:[],
    bounds:{minX:-1,maxX:11,minY:-2,maxY:2},connections:[{name:"a",pointsToConnect:[wire(0,0),wire(10,0)]}]}
  const original:Trace[]=[{type:"pcb_trace",pcb_trace_id:"a",connection_name:"a",
    route:[wire(0,0),wire(1,0),wire(2,1),wire(3,1),wire(4,0),wire(10,0)]}]
  const shorter:Trace[]=[{...original[0],route:[wire(0,0),wire(10,0)]}]
  const validate=async(traces:Trace[])=>{
    const s=BusLanesSolver.forValidation(input,traces,{smoothTuning:true})
    for(let i=0;i<100 && !s.solved && !s.failed;i++)s.step()
    return {valid:s.solved}
  }
  try {
    expect((await ledger.admit({fixture:"control",input,traces:original,provenance:"run1"},validate)).accepted).toBe(true)
    expect((await ledger.admit({fixture:"control",input,traces:shorter,provenance:"run2"},validate)).accepted).toBe(true)
    const pointer=await readFile(join(root,"control/current.json"),"utf8")
    expect((await ledger.admit({fixture:"control",input,traces:original,provenance:"worse fresh run"},validate)).accepted).toBe(false)
    expect((await ledger.admit({fixture:"control",input,traces:[],provenance:"missing nets"},validate)).accepted).toBe(false)
    expect(await readFile(join(root,"control/current.json"),"utf8")).toBe(pointer)
    const id=JSON.parse(pointer).record
    await rm(join(root,"control/records",id+".json"))
    await expect(ledger.admit({fixture:"control",input,traces:original,provenance:"corrupt incumbent"},validate)).rejects.toThrow()
    expect(await readFile(join(root,"control/current.json"),"utf8")).toBe(pointer)
  } finally {await rm(root,{recursive:true,force:true})}
})
