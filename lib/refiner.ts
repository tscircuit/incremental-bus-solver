import { createHash } from "node:crypto"
import { ordinaryRunCandidates } from "../vendor/lib/simplify-matched-traces"
import { length } from "../vendor/lib/geometry"
import { busLengthReports } from "../vendor/lib/route-lengths"
import { VectorScene, fixedCopper, routeCopper } from "../vendor/lib/vector-scene"
import { measureAm3352RoutingQuality } from "../vendor/scripts/measure-am3352-routing-quality"
import type { SimpleRouteJson, Trace, Wire } from "../vendor/lib/types"

export const UPSTREAM = "9fada5b83a67e0e49de54ee7ae8e6974b1c028eb"
export const CONTRACT = "upstream-validation+pareto-quality-v3"
export const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex")
export type Score = { areaMm2: number; copperMm: number; turns: number; shortJogs: number; maxDetour: number }
export type Audit = { valid: boolean; issues?: string[]; [key: string]: unknown }
export type Validator = (traces: Trace[]) => Promise<Audit>
export function score(input: SimpleRouteJson, traces: Trace[]): Score {
  const q = measureAm3352RoutingQuality(input, traces)
  return { areaMm2: q.footprint.bounds?.areaMm2 ?? 0, copperMm: q.totalPlanarLengthMm,
    turns: q.ordinaryTurns, shortJogs: q.shortJogs, maxDetour: q.maxDetourRatio ?? 0 }
}
const tolerances: Score = { areaMm2: 1e-7, copperMm: 1e-7, turns: 0, shortJogs: 0, maxDetour: 1e-9 }
export function compare(previous: Score, next: Score) {
  const keys = Object.keys(previous) as (keyof Score)[]
  if (keys.some(k => !Number.isFinite(next[k]))) return "non_finite_score"
  if (keys.some(k => next[k] > previous[k] + tolerances[k])) return "score_regression"
  if (!keys.some(k => next[k] < previous[k] - tolerances[k])) return "plateau"
  // Tolerances classify strict improvement only. Saved components never increase,
  // even by a rounding epsilon.
  if (keys.some(k => next[k] > previous[k])) return "score_regression"
  return "strict_improvement"
}
export type Proposal = { trace: number; start: number; end: number; points: {x:number;y:number}[]; key: string; gain: number; order: string }
export type Event = { runId: string; stepId: number; incumbentBefore: string; incumbentAfter: string;
  candidateHash: string | null; proposal: Proposal | null; accepted: boolean; reason: string;
  before: Score; candidateScore: Score | null; violations: Audit | null }
export type State = { schema: 1; upstream: string; contract: string; inputHash: string;
  seed: number; runId: string; step: number; best: Trace[]; bestScore: Score;
  bestHash: string; anchorHash: string; queue: Proposal[]; seen: string[]; rejected: number; accepted: number }

/** Local ordinary-run approximation. All other nets, vias, coupled rails and
 * sampled curves retain their current geometry. Whole-board validation follows. */
export function proposals(input: SimpleRouteJson, traces: Trace[], seed: number, seen: Set<string>) {
  const pairs = new Set(input.differentialPairs?.flatMap(p => p.connectionNames))
  const buses = busLengthReports(input,traces)
  const result: Proposal[] = []
  for (const [ti, trace] of traces.entries()) {
    if (pairs.has(trace.connection_name!) || trace.coupledSection) continue
    const constraints = buses.filter(b => b.lengths.some(l => l.name === trace.connection_name))
    const total = constraints[0]?.lengths.find(l => l.name === trace.connection_name)?.totalLengthMm ?? length(trace.route)
    const floor = Math.max(0,...constraints.map(b => Math.max(b.minLengthMm ?? 0,
      b.toleranceMm === null ? 0 : Math.max(0,...b.lengths.filter(l => l.name !== trace.connection_name).map(l => l.totalLengthMm ?? 0))-b.toleranceMm)))
    const curves = new Set(trace.curvedSegments)
    for (let i = 0; i < trace.route.length - 2; i++) {
      for (const span of [3, 7, 15, 31, 63, trace.route.length - 1 - i]) {
        const j = i + span
        if (j >= trace.route.length || j <= i + 1) continue
        const old = trace.route.slice(i, j + 1)
        const first = old[0]
        if (first.route_type !== "wire" || old.some((p, k) => p.route_type !== "wire" ||
          p.layer !== first.layer || p.width !== first.width || (k > 0 && curves.has(i + k)))) continue
        const oldLength = length(old)
        for (const points of ordinaryRunCandidates(old[0], old.at(-1)!, old)) {
          const gain = oldLength - length(points)
          if (gain < -1e-8 || (gain < 1e-8 && points.length >= old.length)) continue
          if (total-gain < floor-1e-8) continue
          const run = [...trace.route.slice(Math.max(0,i-1),i),...points,...trace.route.slice(j+1,j+2)]
          if (run.slice(1,-1).some((b,k) => {
            const a=run[k],c=run[k+2],ab=Math.hypot(b.x-a.x,b.y-a.y),bc=Math.hypot(c.x-b.x,c.y-b.y)
            return ab*bc > 1e-12 && ((b.x-a.x)*(c.x-b.x)+(b.y-a.y)*(c.y-b.y))/(ab*bc) < Math.SQRT1_2-1e-8
          })) continue
          const key = hash([trace.connection_name, old, points])
          if (seen.has(key)) continue
          result.push({trace:ti, start:i, end:j, points, key, gain, order:hash([seed,key])})
        }
      }
    }
  }
  const unique = new Map(result.map(p => [p.key,p]))
  return [...unique.values()].sort((a,b) => b.gain-a.gain || a.order.localeCompare(b.order)).slice(0,4096)
}
export function applyProposal(traces: Trace[], p: Proposal) {
  const candidate = structuredClone(traces), trace = candidate[p.trace]
  const wire = trace.route[p.start] as Wire
  const delta = p.points.length - (p.end - p.start + 1)
  trace.route = [...trace.route.slice(0,p.start), ...p.points.map(point => ({...wire,...point})), ...trace.route.slice(p.end+1)]
  trace.curvedSegments = trace.curvedSegments?.map(k => k > p.end ? k+delta : k)
  return candidate
}
export class Refiner {
  private constructor(public state: State, readonly input: SimpleRouteJson, readonly validate: Validator) {}
  static async create(input: SimpleRouteJson, traces: Trace[], seed: number, validate: Validator) {
    const audit = await validate(structuredClone(traces))
    if (!audit.valid) throw Error("Cannot seed incumbent from invalid routing: "+JSON.stringify(audit))
    const best = structuredClone(traces), bestHash = hash(best), inputHash = hash(input)
    return new Refiner({schema:1, upstream:UPSTREAM, contract:CONTRACT, inputHash, seed,
      runId:hash([UPSTREAM,CONTRACT,inputHash,bestHash,seed]).slice(0,20), step:0,
      best, bestScore:score(input,best), bestHash, anchorHash:bestHash,
      queue:proposals(input,best,seed,new Set()), seen:[], rejected:0, accepted:0}, structuredClone(input),validate)
  }
  static async restore(input: SimpleRouteJson, saved: State, validate: Validator) {
    if (saved.schema !== 1 || saved.upstream !== UPSTREAM || saved.contract !== CONTRACT || saved.inputHash !== hash(input))
      throw Error("Checkpoint revision/contract/input mismatch")
    if (saved.bestHash !== hash(saved.best) || hash(saved.bestScore) !== hash(score(input,saved.best)))
      throw Error("Checkpoint incumbent hash/score mismatch")
    const audit = await validate(structuredClone(saved.best))
    if (!audit.valid) throw Error("Checkpoint failed independent revalidation")
    return new Refiner(structuredClone(saved),structuredClone(input),validate)
  }
  async step(): Promise<{event:Event; candidate:Trace[] | null}> {
    const s = this.state, before = {...s.bestScore}, incumbentBefore = s.bestHash
    const p = s.queue.shift() ?? null
    let candidate: Trace[] | null = null, next: Score | null = null, audit: Audit | null = null
    let reason = "search_exhausted", accepted = false
    if (p) {
      s.seen.push(p.key)
      candidate = applyProposal(s.best,p)
      const original = this.input.connections.find(c => c.name === s.best[p.trace].connection_name)!
      const a = s.best[p.trace].route[p.start] as Wire
      const scene = new VectorScene(this.input,{...original,pointsToConnect:[a,{...s.best[p.trace].route[p.end],layer:a.layer}]},a.width,
        [...fixedCopper(this.input),...s.best.flatMap(routeCopper)])
      if (!scene.pathVisible(p.points)) reason="local_clearance_failed"
      else {
        next = score(this.input,candidate)
        reason = compare(before,next)
      }
      // Never promote based on a score or solver success flag alone.
      if (reason === "strict_improvement") {
        audit = await this.validate(structuredClone(candidate))
        if (!audit.valid) reason = "independent_validation_failed"
        else {
          s.best = structuredClone(candidate); s.bestHash = hash(s.best); s.bestScore = next!
          accepted = true; s.accepted++
          s.queue = proposals(this.input,s.best,s.seed,new Set(s.seen))
        }
      }
      if (!accepted) s.rejected++
      if (!s.queue.length) s.queue = proposals(this.input,s.best,s.seed,new Set(s.seen))
    }
    s.step++
    return {event:{runId:s.runId,stepId:s.step,incumbentBefore,incumbentAfter:s.bestHash,
      candidateHash:candidate ? hash(candidate) : null,proposal:p,accepted,reason,before,candidateScore:next,violations:audit},candidate}
  }
}
