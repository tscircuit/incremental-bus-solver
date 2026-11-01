import { expect, test } from "bun:test"
import { loadAm3352Sample } from "../vendor/scripts/am3352-samples"
import { validateAm3352Sample } from "../vendor/scripts/validate-am3352-sample"
import { hash, score } from "../lib/refiner"
for (const name of ["control","left","inner-layers-complete-ca"] as const) {
  test("pinned actual fixture integrity and independent checks: "+name,async()=>{
    const {input,metadata}=await loadAm3352Sample(name), before=hash(input)
    expect(input.connections.length).toBe(47)
    expect(metadata.fixedFanoutTraces.length).toBe(161)
    expect((await validateAm3352Sample(input,metadata)).fixedDrc.valid).toBe(true)
    const missing=await validateAm3352Sample(input,metadata,[])
    expect(missing.valid).toBe(false)
    expect(missing.complete).toBe(false)
    expect(hash(input)).toBe(before)
    expect(score(input,[])).toEqual(score(structuredClone(input),[]))
    const corrupted=structuredClone(input); corrupted.minTraceWidth+=0.001
    await expect(validateAm3352Sample(corrupted,metadata)).rejects.toThrow("rules")
  },30000)
}
