import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Refiner, score, hash, compare } from "../lib/refiner"
import { Store, checkpointStatesEqual } from "../lib/store"
import { BusLanesSolver } from "../vendor/lib/bus-lanes-solver"
import type { SimpleRouteJson, Trace, Wire } from "../vendor/lib/types"
const wire = (x:number,y:number):Wire => ({route_type:"wire",x,y,layer:"top",width:0.1})
const fixture = () => {
  const input: SimpleRouteJson = {layerCount:2,minTraceWidth:0.1,minTraceToPadEdgeClearance:0.1,
    bounds:{minX:-2,maxX:12,minY:-4,maxY:4},obstacles:[],
    connections:[{name:"a",pointsToConnect:[wire(0,0),wire(10,0)]}]}
  const traces:Trace[] = [{type:"pcb_trace",pcb_trace_id:"a",connection_name:"a",
    route:[wire(0,0),wire(1,0),wire(2,1),wire(3,1),wire(4,0),wire(10,0)]}]
  const validate = async (candidate:Trace[]) => {
    const solver = BusLanesSolver.forValidation(input,candidate,{smoothTuning:true})
    for(let i=0;i<1000 && !solver.solved && !solver.failed;i++) solver.step()
    return {valid:solver.solved,issues:solver.error?[solver.error]:[]}
  }
  return {input,traces,validate}
}
test("score and seeded accepted/rejected decisions are deterministic; local shortening succeeds",async()=>{
  const {input,traces,validate} = fixture(), before=hash({input,traces})
  expect(await validate(traces)).toMatchObject({valid:true})
  expect(score(input,traces)).toEqual(score(structuredClone(input),structuredClone(traces)))
  const a=await Refiner.create(input,traces,61,validate), b=await Refiner.create(input,traces,61,validate)
  for(let i=0;i<8;i++) expect((await a.step()).event).toEqual((await b.step()).event)
  expect(a.state.accepted).toBeGreaterThan(0)
  expect(a.state.bestScore.copperMm).toBeLessThan(score(input,traces).copperMm)
  expect(hash({input,traces})).toBe(before)
})
test("missing required nets cannot seed or replace a valid incumbent",async()=>{
  const {input,traces,validate}=fixture()
  await expect(Refiner.create(input,[],1,validate)).rejects.toThrow("invalid routing")
  const s=await Refiner.create(input,traces,1,validate), saved=structuredClone(s.state)
  saved.best=[]; saved.bestHash=hash([]); saved.bestScore=score(input,[])
  await expect(Refiner.restore(input,saved,validate)).rejects.toThrow("independent revalidation")
})
test("a tempting shortcut through fixed copper is rejected and best is monotone",async()=>{
  const {input,traces,validate}=fixture()
  input.obstacles.push({center:{x:2.5,y:0},width:0.4,height:0.3,layers:["top"],connectedTo:["power"]})
  const s=await Refiner.create(input,traces,61,validate)
  let invalid=0, prior={...s.state.bestScore}
  for(let i=0;i<20;i++) {
    const {event}=await s.step()
    invalid+=Number(event.reason==="independent_validation_failed" || event.reason==="local_clearance_failed")
    for(const k of Object.keys(prior) as (keyof typeof prior)[]) expect(s.state.bestScore[k]).toBeLessThanOrEqual(prior[k])
    prior={...s.state.bestScore}
  }
  expect(invalid).toBeGreaterThan(0)
})
test("persisted resume equals uninterrupted replay and rejects changed rules",async()=>{
  const {input,traces,validate}=fixture(), dir=await mkdtemp(join(tmpdir(),"ddr-test-")), store=new Store(dir)
  try {
    const release=await store.lock()
    await expect(store.lock()).rejects.toThrow()
    const a=await Refiner.create(input,traces,9,validate)
    await store.commit(a.state,null)
    const first=await a.step(); await store.commit(a.state,first.event,first.candidate)
    expect(await store.loadAt(0)).toEqual(await Refiner.create(input,traces,9,validate).then(s=>s.state))
    const b=await Refiner.restore(input,await store.load(),validate)
    expect(checkpointStatesEqual(a.state,await store.load())).toBe(true)
    const changed=structuredClone(await store.load()); changed.bestScore.copperMm+=1
    expect(checkpointStatesEqual(a.state,changed)).toBe(false)
    for(let i=0;i<5;i++) expect((await a.step()).event).toEqual((await b.step()).event)
    expect(a.state).toEqual(b.state)
    await expect(Refiner.restore({...input,minTraceWidth:0.2},b.state,validate)).rejects.toThrow("mismatch")
    const bad=structuredClone(b.state); bad.bestScore.copperMm+=1; bad.bestHash="different"
    await expect(store.commit(bad,null)).rejects.toThrow("worsen")
    await release()
  } finally {await rm(dir,{recursive:true,force:true})}
})
test("Pareto gate rejects all regressions, plateaus, NaN, and rounding increases",()=>{
  const a={areaMm2:1,copperMm:2,turns:3,shortJogs:4,maxDetour:5}
  expect(compare(a,a)).toBe("plateau")
  expect(compare(a,{...a,copperMm:NaN})).toBe("non_finite_score")
  expect(compare(a,{...a,areaMm2:0.5,turns:4})).toBe("score_regression")
  expect(compare(a,{...a,areaMm2:0.5,copperMm:2+1e-10})).toBe("score_regression")
})
