import { expect, test } from "bun:test"
import { IncrementalBusSolver } from "../lib"
import { hash } from "../lib/refiner"
import type { SimpleRouteJson } from "../vendor/lib/types"
test("benchmark adapter exposes complete output and preserves caller input",()=>{
  const input:SimpleRouteJson={layerCount:2,minTraceWidth:0.1,
    bounds:{minX:-1,maxX:6,minY:-1,maxY:2},obstacles:[],
    connections:[{name:"a",pointsToConnect:[{x:0,y:0,layer:"top"},{x:5,y:0,layer:"top"}]}]}
  const before=hash(input),solver=new IncrementalBusSolver(input,{fanout:"none"})
  for(let i=0;i<1000 && !solver.solved && !solver.failed;i++) solver.step()
  expect(solver.solved).toBe(true)
  expect(solver.traces.length).toBe(1)
  expect(solver.getOutput().traces.length).toBe(1)
  expect(hash(input)).toBe(before)
  expect(solver.stats.incrementalRefinement).toEqual({skipped:"non_native_fixture"})
})
