// Rebuilds the reference section of docs/COMMANDS.md (everything after "## Reference")
// and docs/tools.json from the command table in js/07-api.js.  Run: node tools/gendocs.js .
const fs=require('fs'),vm=require('vm'),path=require('path');
const root=process.argv[2];
const noop=()=>{};
const ctx={console,setInterval:noop,setTimeout,clearTimeout,URLSearchParams,
  location:{search:'',origin:'',pathname:''},
  document:{addEventListener:noop,getElementById:()=>null,body:{dataset:{}}},
  window:{addEventListener:noop}};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root,'js/07-api.js'),'utf8')+';this.SSA=SSA;',ctx);
const d=ctx.SSA.describe();
fs.writeFileSync(path.join(root,'docs/tools.json'),JSON.stringify(ctx.SSA.tools(),null,1)+'\n');
const groups=[...new Set(d.commands.map(c=>c.group))];
let md='';
for(const g of groups){
  md+='\n### '+g[0].toUpperCase()+g.slice(1)+'\n\n';
  for(const c of d.commands.filter(x=>x.group===g)){
    md+='#### `'+c.name+'`\n\n'+c.summary+'\n\n';
    const a=Object.entries(c.args);
    if(a.length){
      md+='| Option | Type | Notes |\n| --- | --- | --- |\n';
      for(const[k,s] of a){
        let t=s.type==='object_ref'?'name or NORAD':s.type==='enum'?s.values.join(' \\| '):s.type;
        const notes=[s.required?'**required**':'',s.desc||'',s.min!==undefined||s.max!==undefined?'range '+(s.min??'')+' to '+(s.max??''):'',
          s.default!==undefined&&s.default!==''?'default `'+JSON.stringify(s.default)+'`':'',
          s.aliases?'also accepts '+Object.entries(s.aliases).map(([k2,v])=>'*'+k2+'*: '+v.join(', ')).join('; '):''].filter(Boolean).map(x=>x.replace(/\.$/,'')).join('. ');
        md+='| `'+k+'` | '+t+' | '+notes.replace(/\|/g,'\\|')+' |\n';
      }
      md+='\n';
    } else md+='No options.\n\n';
    if(c.say.length) md+='Example requests: '+c.say.map(x=>'"'+x+'"').join(', ')+'\n\n';
  }
}
const docP=path.join(root,'docs/COMMANDS.md');
const doc=fs.readFileSync(docP,'utf8'),cut=doc.indexOf('## Reference');
if(cut<0) throw new Error('docs/COMMANDS.md has no "## Reference" heading');
fs.writeFileSync(docP,doc.slice(0,cut)+'## Reference\n'+md);
console.error(d.commands.length+' commands');
