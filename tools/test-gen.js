global.Delaunator = require('D:/projects/fantasy-map/js/vendor/delaunator.min.js');
global.self = global;
require('D:/projects/fantasy-map/js/gen.js');
for (const [seed,cells,shape] of [['dnd',12000,'classic'],['abc',20000,'crescent'],['x1',5000,'twin'],['big',40000,'long']]) {
  const m = FMG.generate({seed,cells,shape});
  console.log(seed, cells, JSON.stringify(m.timings, (k,v)=>typeof v==='number'?Math.round(v):v));
  console.log(' land', m.landCells, 'burgs', m.burgs.length, 'states', m.states.length, m.states.map(s=>s.fullName+'('+s.cells+')').join(', '));
  console.log(' cultures', m.cultures.map(c=>c.name).join(','), 'rivers', m.rivers.length, 'named', m.rivers.filter(r=>r.name).map(r=>r.name).join(','), 'roads', m.roads.length, 'coast', m.coast.length, 'lakes', m.lakes.length, 'icons', m.icons.length, 'name', m.name);
  console.log(' towns', m.burgs.slice(0,12).map(b=>b.name+':'+b.type+':'+b.pop).join(', '), 'noroad', m.burgs.filter(b=>!b.capital&&!b.road).length);
}
