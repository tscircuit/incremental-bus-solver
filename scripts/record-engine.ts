import { resolve,join } from "node:path"
import { hostname } from "node:os"
import { createHash } from "node:crypto"
import { UPSTREAM,CONTRACT } from "../lib/refiner"

const directory=resolve(process.argv[2]??"results/reproduction")
const modules:Record<string,string>={}
for(const path of ["lib/refiner.ts","lib/solver.ts","lib/store.ts","scripts/refinement-worker.ts"])
  modules[path]=createHash("sha256").update(new Uint8Array(await Bun.file(resolve(import.meta.dir,"..",path)).arrayBuffer())).digest("hex")
await Bun.write(join(directory,"measured-engine.json"),JSON.stringify({
  upstream:UPSTREAM,contract:CONTRACT,modules,
  environment:{host:hostname(),architecture:process.arch,runtime:"Bun "+Bun.version},
},null,2)+"\n")
