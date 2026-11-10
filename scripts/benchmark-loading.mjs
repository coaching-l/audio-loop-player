// After npm start: node scripts/benchmark-loading.mjs /path/to/audio.mp3
import {chromium} from '@playwright/test';
import {existsSync} from 'node:fs';
import {resolve, basename} from 'node:path';
import {execFileSync} from 'node:child_process';
import {writeFile, mkdir} from 'node:fs/promises';
const root=resolve(import.meta.dirname,'..');
const input=resolve(process.argv[2] || 'tests/fixtures/tone.mp3');
const name=basename(input);
const type=name.endsWith('.wav')?'audio/wav':name.endsWith('.m4a')?'audio/mp4':'audio/mpeg';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--no-sandbox']});
const results=[];
try {
 for(const version of ['before','after']){ console.log('Starting',version);
  const context=await browser.newContext({serviceWorkers:'block'});
  if(version==='before') for(const name of ['practice.js','audio-import.js','audio-library.js','app.js']){
    const source=execFileSync('git',['show',`334e4ee:${name}`],{cwd:root,encoding:'utf8'});
    await context.route(`**/${name}*`,r=>r.fulfill({contentType:'text/javascript',body:source}));
  }
  const page=await context.newPage();
  await page.route('**/benchmark.mp3',r=>r.fulfill({path:input,contentType:type}));
  await page.goto('http://127.0.0.1:4173');
  const data=await page.evaluate(async({name,type})=>{
    const bytes=await(await fetch('./benchmark.mp3')).arrayBuffer();
    const {openPractice}=await import('./practice.js');
    const {storedFile,addAudio,listAudio}=await import('./audio-library.js');
    await addAudio(new File([bytes],name,{type,lastModified:123}));
    const [record]=await listAudio();
    const trials=[];
    for(let n=0;n<5;n++){
      const file=storedFile(record);
      let reads=0;const read=file.arrayBuffer.bind(file);
      file.arrayBuffer=()=>{if(document.getElementById('player-controls').disabled)reads++;return read();};
      const start=performance.now();
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error(document.getElementById("play-status").textContent+" / "+document.getElementById("error").textContent)),20000);
        const play=document.getElementById('player-controls');
        const observer=new MutationObserver(()=>{
          if(!play.disabled){observer.disconnect();clearTimeout(timer);resolve();}
        });
        observer.observe(play,{attributes:true,attributeFilter:['disabled']});
        void openPractice({file});
      });
      trials.push({ms:performance.now()-start,readsBeforeReady:reads});
      await new Promise(r=>setTimeout(r,500));
    }
    return {bytes:bytes.byteLength,trials};
  },{name,type});
  results.push({version,...data});
  await context.close();
 }
}finally{await browser.close();}
console.log(JSON.stringify(results,null,2));
await mkdir(resolve(root,'test-results'),{recursive:true});
await writeFile(resolve(root,'test-results/loading-benchmark.json'),JSON.stringify(results,null,2));
