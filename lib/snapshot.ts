import type { SimpleRouteJson, Trace } from "../vendor/lib/types"
const escape = (x:string) => x.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;")
export function snapshot(input:SimpleRouteJson,traces:Trace[],label:string) {
  const b=input.bounds, w=b.maxX-b.minX,h=b.maxY-b.minY
  const layers=["top","inner1","inner2","bottom"]
  const colors=["#f97316","#38bdf8","#a3e635","#e879f9"]
  let content=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w*2+6} ${h*2+10}"><rect width="100%" height="100%" fill="#111827"/><text x="1" y="2" font-size="1.4" fill="white">${escape(label)}</text>`
  for(const [li,layer] of layers.entries()) {
    const dx=(li%2)*(w+3)+1,dy=Math.floor(li/2)*(h+3)+5
    content+=`<text x="${dx}" y="${dy-1}" fill="white" font-size="1.5">${layer}</text><g transform="translate(${dx-b.minX},${dy+b.maxY}) scale(1,-1)">`
    content+=`<rect x="${b.minX}" y="${b.minY}" width="${w}" height="${h}" fill="none" stroke="#64748b" stroke-width="0.1"/>`
    for(const o of input.obstacles.filter(o=>o.layers.includes(layer)))
      content+=`<rect x="${o.center.x-o.width/2}" y="${o.center.y-o.height/2}" width="${o.width}" height="${o.height}" fill="#475569"/>`
    for(const [fixed,set] of [[true,input.traces??[]],[false,traces]] as const) {
      for(const t of set) {
        for(let i=0;i<t.route.length;i++) {
          const p=t.route[i],a=t.route[i-1]
          if(p.route_type==="wire" && p.layer===layer && a?.route_type==="wire" && a.layer===layer)
            content+=`<path d="M${a.x},${a.y}L${p.x},${p.y}" fill="none" stroke="${fixed?"#6b7280":colors[li]}" stroke-width="${p.width}"><title>${escape(t.connection_name??t.pcb_trace_id)}</title></path>`
          if(p.route_type==="via" && (p.layers??[p.from_layer,p.to_layer]).includes(layer))
            content+=`<circle cx="${p.x}" cy="${p.y}" r="${(p.via_diameter??input.minViaPadDiameter??0.3)/2}" fill="none" stroke="${fixed?"#6b7280":colors[li]}" stroke-width="0.07"/>`
        }
      }
    }
    content+="</g>"
  }
  return content+"</svg>"
}
