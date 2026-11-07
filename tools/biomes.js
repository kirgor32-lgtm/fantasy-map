global.Delaunator=require('../js/vendor/delaunator.min.js');global.self=global;require('../js/gen.js');
const seeds=process.argv.slice(2).length?process.argv.slice(2):['dnd','tamriel','abc','x1','q7','zz'];
for(const cl of ['temperate','cold','hot'])for(const s of seeds){const m=FMG.generate({seed:s,climate:cl});const cnt={};let land=0;
for(let c=0;c<m.n;c++)if(m.type[c]===0){land++;cnt[m.biome[c]]=(cnt[m.biome[c]]||0)+1}
const p=b=>((cnt[b]||0)/land*100).toFixed(1);
console.log(cl.padEnd(9),s.padEnd(8),'лед',p(11),'пуст',p(1),'хол.пуст',p(2),'тундра',p(10),'тайга',p(9),'джунгли',p(7),'саванна',p(3),'болото',p(12),'луга',p(4),'лес',p(6),'сез',p(5),'влаж',p(8),'горы',p(13));}
