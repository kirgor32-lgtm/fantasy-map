global.Delaunator=require('../js/vendor/delaunator.min.js');global.self=global;require('../js/gen.js');
for(const [s,cells] of [['dnd',12000],['tamriel',12000],['abc',12000],['x1',40000],['q7',5000]]){const t=Date.now();const m=FMG.generate({seed:s,cells});const ms=Date.now()-t;
const km=m.W*m.H/m.n; const d=new Int32Array(m.n).fill(-1);const q=[];for(const b of m.burgs){d[b.cell]=0;q.push(b.cell)}
for(let i=0;i<q.length;i++){const c=q[i];for(let k=m.nOff[c];k<m.nOff[c+1];k++){const o=m.nbr[k];if(o>=0&&d[o]<0&&m.type[o]!==1){d[o]=d[c]+1;q.push(o)}}}
const ck=Math.sqrt(m.W*m.H/m.n)*m.kmPerUnit;let far=0,L=0;for(let c=0;c<m.n;c++)if(m.type[c]===0&&m.biome[c]!==11){L++;if(d[c]*ck>90)far++}
const ty={};m.burgs.forEach(b=>ty[b.type]=(ty[b.type]||0)+1);
console.log(s,cells,ms+'ms','burgs',m.burgs.length,JSON.stringify(ty),'land>90km from town:',(far/L*100).toFixed(1)+'%','roads',m.roads.length)}
