/* Trusted-main test result gate. Takes results produced by run-tests.sh,
 * never accepts an agent-authored test report as evidence.
 */
'use strict';
const fs=require('node:fs');
const [configPath,resultsPath,requiredRaw,sha,mission]=process.argv.slice(2);
if(!/^[a-f0-9]{40}$/i.test(sha||'')||
 !/^[a-f0-9-]{36}$/i.test(mission||''))throw Error('invalid_run_identity');
const cfg=JSON.parse(fs.readFileSync(configPath,'utf8'));
const required=JSON.parse(requiredRaw);
if(!Array.isArray(required)||required.length<1||required.length>10||
 required.some(x=>!cfg.requiredTestIds.includes(x))||
 new Set(required).size!==required.length)throw Error('unapproved_required_test_id');
const results=fs.readFileSync(resultsPath,'utf8').trim().split(/\r?\n/);
const passed=new Set();
for(const line of results){
 const [id,status,...extra]=line.split('\t');
 if(extra.length||!cfg.requiredTestIds.includes(id)||status!=='passed'||
  passed.has(id))throw Error('malformed_trusted_test_result');
 passed.add(id);
}
for(const id of required)if(!passed.has(id))throw Error('required_test_not_executed_'+id);
process.stdout.write(JSON.stringify({
 schema:'paperworld-result-v1',projectId:cfg.projectId,
 commit_sha:sha,mission,required_tests:required.map(id=>({id,status:'passed'})),
 executed_tests:[...passed]
})+'\n');
