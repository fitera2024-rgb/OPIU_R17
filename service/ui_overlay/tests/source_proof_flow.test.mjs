import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const here=dirname(fileURLToPath(import.meta.url));
const web=join(here,'..','web');
const script=readFileSync(join(web,'app.js'),'utf8');
const html=readFileSync(join(web,'index.html'),'utf8');
const css=readFileSync(join(web,'app.css'),'utf8');
const start=script.indexOf('/* SOURCE_PROOF_LOGIC_START */');
const end=script.indexOf('/* SOURCE_PROOF_LOGIC_END */');
assert.ok(start>=0&&end>start,'business source logic markers must exist');
const context={};
vm.createContext(context);
vm.runInContext(script.slice(start,end),context);

function ready(){return {source_readiness:{ready:true,status:'READY',message:'Источники готовы',organization_name:'Организация 1',period:'2025-10',sources:{erp:{package_name:'ERP package'},intalev:{package_name:'Инталев package'}},posting_rows:0,ready_to_upload:false,release_allowed:false,live_1c_allowed:false}}}

test('business readiness exposes only operator concepts',()=>{
 const data=ready(),readiness=context.businessSourceReadiness(data);
 assert.equal(context.businessRunAvailable(data),true);
 assert.equal(context.businessSourceName(readiness,'erp'),'ERP package');
 assert.equal(context.businessSourceName(readiness,'intalev'),'Инталев package');
 assert.deepEqual(JSON.parse(JSON.stringify(readiness.sources)),{erp:{package_name:'ERP package'},intalev:{package_name:'Инталев package'}});
});

test('missing business readiness fails closed',()=>{
 const readiness=context.businessSourceReadiness({});
 assert.equal(readiness.ready,false);
 assert.equal(context.businessRunAvailable({}),false);
 assert.match(readiness.message,/ERP.*Инталев/);
});

test('normal UI has no technical source-proof panel or controls',()=>{
 const visible=html+css;
 for(const forbidden of ['source-proof-panel','source-proof-evidence','source-proof-approve','source-proof-preflight','source-proof-confirm','data-source-proof-root','data-source-proof-candidate','data-source-proof-file'])assert.ok(!visible.includes(forbidden),`forbidden normal UI control: ${forbidden}`);
 for(const label of ['evidence JSON','SHA-256','package digest','proof digest','path identity','digest'])assert.ok(!visible.toLowerCase().includes(label.toLowerCase()),`forbidden normal UI label: ${label}`);
 assert.ok(html.includes('source-readiness-panel'));
 assert.ok(script.includes('Запустить сверку R005'));
});

test('Engines offers a business path to reselect ERP and Intalev packages',()=>{
 const render=script.slice(script.indexOf('function renderSourceReadiness'),script.indexOf('async function startR005'));
 assert.match(render,/data-source-reselect="1"/);
 assert.match(render,/aria-controls="view-files"/);
 assert.match(render,/Перевыбрать пакеты ERP и Инталев/);
 assert.doesNotMatch(render,/\/api\/engine\/prepare|source_proof_options|evidence_path|approved_evidence|source_roots|expected_preflight_digest/);
 assert.equal((render.match(/data-r005-start/g)||[]).length,0);
 assert.match(render,/goView\('files'\)/);
 assert.match(render,/choose-input-files/);
 assert.match(render,/scrollIntoView/);
 assert.match(render,/\.focus\(\)/);
});

test('one R005 business action delegates hidden proof orchestration to service',()=>{
 const startFunction=script.slice(script.indexOf('async function startR005'),script.indexOf('function renderEngines'));
 assert.match(startFunction,/\/api\/modules\/open/);
 assert.match(startFunction,/resolve_source_proof:true/);
 assert.match(startFunction,/business_action_id:businessActionId/);
 assert.doesNotMatch(startFunction,/\/api\/engine\/prepare|source_proof_options|evidence_path|approved_evidence|source_roots|expected_preflight_digest/);
 assert.match(startFunction,/if\(state\.sourceStart\.busy\)return/);
});

test('input package detection is structural and never filename-gated',()=>{
 const upload=script.slice(script.indexOf('async function uploadFiles'),script.indexOf('async function decideRules'));
 assert.match(upload,/if\(kind==='input'\)\{const finalized=await api\('\/api\/intalev-packages\/finalize'/);
 assert.doesNotMatch(upload,/files\.some\(f=>\/инталев\|intalev\/i|input\.id==='input-folder'/);
});

test('Rules and R001 controls require a validated active RUN',()=>{
 const render=script.slice(script.indexOf('function renderEngines'),script.indexOf('function resultBucket'));
 assert.match(render,/activeRunCapabilities/);
 assert.match(render,/rules_available|capabilities\.rules/);
 assert.match(render,/r001_available|capabilities\.r001/);
 assert.match(render,/updateRulesEngineR001Action/);
 const r001Action=script.slice(script.indexOf('function rulesEngineR001ActionView'),script.indexOf('function renderRulesEngineDecisionTable'));
 assert.match(r001Action,/activeRunCapabilities\(state\.data\)\.r001/);
 assert.match(r001Action,/rerun-r001-top/);
});

test('UI never enables financial release flags',()=>{
 assert.doesNotMatch(script,/ready_to_upload\s*:\s*true|release_allowed\s*:\s*true|live_1c_allowed\s*:\s*true|posting_rows\s*:\s*[1-9]/);
});
