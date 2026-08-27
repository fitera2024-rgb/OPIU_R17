import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=join(fileURLToPath(new URL('.',import.meta.url)),'..','web');
const port=Number(process.argv[2]||43166);
const host=process.argv[3]||'127.0.0.1';
let scenario='happy';
let runs=0;
let preflightCalls=0;
let confirmCalls=0;
let rulesApplyCalls=0;
let r001OpenCalls=0;
let rulesApplied=false;
let lastRuleDecision=null;
const acceptedActions=new Map();

function readiness(){
 const messages={
  'missing-erp':'Не выбран пакет ERP. Загрузите или выберите его заново.',
  'missing-intalev':'Не выбран пакет Инталев. Загрузите или выберите его заново.',
  'mixed-org':'Источники относятся к другой организации. Выберите пакеты заново.',
  'mixed-period':'Выберите период заново: источники относятся к другому периоду.',
  ambiguous:'Не удалось однозначно определить источник. Выберите пакет заново.'
 };
 const blocked=messages[scenario];
 return {ready:!blocked,status:blocked?'BLOCKED':'READY',message:blocked||'Источники готовы',organization_name:'Организация 1',period:'2025-10',sources:blocked?{}:{erp:{package_name:'ERP package'},intalev:{package_name:'Инталев package'}},posting_rows:0,ready_to_upload:false,release_allowed:false,live_1c_allowed:false};
}

function bootstrap(){
 const active=runs?`RUN-FIXTURE-${runs}`:'';
 const runRecords=active?[{run_id:active,source_proof_valid:true,rules_available:true,r001_available:scenario==='rules-sporno'&&rulesApplied}]:[];
 const inputs=[{name:'ERP package',size:20},{name:'Инталев package',size:20}].filter(item=>scenario!=='missing-erp'||!item.name.startsWith('ERP')).filter(item=>scenario!=='missing-intalev'||!item.name.startsWith('Инталев'));
 return {settings:{organization_id:'ORG-1',organization_name:'Организация 1',organization_path:'Холдинг / Организация 1',period_mode:'month',period:'2025-10',author:'Browser fixture',active_run_id:active,workflow_stage:active?'R005_PREPARED':'INPUTS_PENDING',include_descendants:false},organizations:[{node_id:'ORG-1',node_name:'Организация 1',hierarchy_path:'Холдинг / Организация 1'}],organization_source:{title:'Fixture hierarchy'},counts:{rules:0,published_rules:0,imported_review:0,inputs:inputs.length,outputs:0,instructions:0,applications:0,artifacts:0},workflow:{stage_label:active?'Сверка запущена':'Ожидает источники',next_action:readiness().message,steps:[]},files:{inputs,outputs:[]},rules:[],revisions:[],applications:[],approvals:[],catalogs:[],reference_status:{erp_shared:{status:'PINNED'},intalev:{status:'ACTIVE'}},source_readiness:readiness(),instructions:[],materials:[],modules:[{module_id:'reconciliation-engine',title:'R005 fixture',version:'R005',status:'CONNECTED_READ_ONLY',note:'Sanitized browser fixture'},{module_id:'rules-engine',title:'Rules fixture',version:'Rules',status:'CONNECTED_READ_ONLY',note:'Requires validated RUN'},{module_id:'correction-files-engine',title:'R001 fixture',version:'R001',status:'CONNECTED_READ_ONLY',note:'Requires validated RUN'}],runs:runRecords,artifacts:[]};
}

function rulesResult(){
 const active=runs?`RUN-FIXTURE-${runs}`:'';
 const nextAction=rulesApplied?'PASS_TO_R001':'WAIT_USER_RULES';
 const row={kind:'candidate',candidate_id:'CAND-FIXTURE-1',candidate_revision_id:'CRV-FIXTURE-1',result_category:'review_required',user_status:rulesApplied?'MANUAL_REVIEW':'PENDING_REVIEW',impact_class:'CORRECTION_ANALYTICS',intalev:{article_code:'R025',article_name:'Мат помощь и прочие выплаты',article_path:'Расходы на персонал / Мат помощь и прочие выплаты',opiu_block_name:'Расходы на персонал',amount:243995},erp:{article_code:'ERP-R025',article_name:'Мат помощь и прочие выплаты',article_path:'Расходы на персонал / Мат помощь и прочие выплаты',opiu_block_name:'Расходы на персонал',amount:243995},accounting:{},action:{action_type:'STORNO_REPOST',parameters:{delta:243995}},evidence:{proof_status:'UNPROVEN',explanation:'Требуется проверка счетов ERP.',evidence_rows:[{date:'2025-10-31',registrar:'Операция ERP',document:'0001',posting_number:'1',debit_account:'26',credit_account:'79.1',article:'Мат помощь и прочие выплаты',amount:243995,source_row:'15'}]}};
 return {ok:true,run_id:active,rules_execution_id:'ITER-FIXTURE-1',next_action:nextAction,workflow:{next_action:nextAction,disputed_draft_count:rulesApplied?1:0,blocking_unresolved_count:rulesApplied?0:1},decision_rows:[row],categories:{effective:[],candidates_to_add:[],review_required:[row],blockers_errors:[]},counts:{effective:0,candidates_to_add:0,review_required:1,blockers_errors:0},safety:{report_only:true,posting_rows:0,ready_to_upload:false,release_allowed:false,live_1c_allowed:false}};
}

function sendJSON(response,status,value){const body=Buffer.from(JSON.stringify(value));response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store'});response.end(body)}
async function requestBody(request){const chunks=[];for await(const chunk of request)chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')}

const server=createServer(async(request,response)=>{
 const url=new URL(request.url,'http://127.0.0.1');
 if(url.pathname==='/_control'){scenario=url.searchParams.get('scenario')||'happy';runs=scenario==='rules-sporno'?1:0;preflightCalls=0;confirmCalls=0;rulesApplyCalls=0;r001OpenCalls=0;rulesApplied=false;lastRuleDecision=null;acceptedActions.clear();return sendJSON(response,200,{ok:true,scenario,runs})}
 if(url.pathname==='/_status')return sendJSON(response,200,{scenario,runs,preflight_calls:preflightCalls,confirm_calls:confirmCalls,rules_apply_calls:rulesApplyCalls,r001_open_calls:r001OpenCalls,rules_applied:rulesApplied,last_rule_decision:lastRuleDecision,posting_rows:0,ready_to_upload:false,release_allowed:false,live_1c_allowed:false});
 if(url.pathname==='/api/bootstrap')return sendJSON(response,200,bootstrap());
 if(url.pathname==='/api/rules-engine/result')return sendJSON(response,200,scenario==='rules-sporno'?rulesResult():{result:{run_id:runs?`RUN-FIXTURE-${runs}`:'',effective:[],candidates_to_add:[],review_required:[],blockers_errors:[]}});
 if(url.pathname==='/api/rule-catalog'){
  if(url.searchParams.get('catalog')==='CHART_OF_ACCOUNTS')return sendJSON(response,200,{system:'ERP',catalog:'CHART_OF_ACCOUNTS',catalog_version_id:'ERPACCT-FIXTURE-1',items:[{account_id:'ACC-26',code:'26',name:'Общехозяйственные расходы'},{account_id:'ACC-791',code:'79.1',name:'Внутрихозяйственные расчеты'},{account_id:'ACC-91',code:'91.02',name:'Прочие расходы'}],count:3,report_only:true,posting_rows:0,ready_to_upload:false,release_allowed:false,live_1c_allowed:false});
  return sendJSON(response,200,{system:'ERP',catalog:'OPIU_ARTICLES',items:[{code:'ERP-R025',name:'Мат помощь и прочие выплаты',path:'Расходы на персонал / Мат помощь и прочие выплаты',block:'Расходы на персонал'}],count:1});
 }
 if(url.pathname==='/api/rules-engine/apply-decisions'){
  const body=await requestBody(request),decision=body.decisions?.[0];
  if(scenario!=='rules-sporno'||body.run_id!=='RUN-FIXTURE-1'||body.decisions?.length!==1||decision?.candidate_id!=='CAND-FIXTURE-1'||decision?.candidate_revision_id!=='CRV-FIXTURE-1'||decision?.decision!=='MANUAL_REVIEW'||decision?.edited_rule?.account_selection?.catalog_version_id!=='ERPACCT-FIXTURE-1'||decision?.edited_rule?.account_selection?.debit_account_id!=='ACC-26'||decision?.edited_rule?.account_selection?.credit_account_id!=='ACC-791')return sendJSON(response,409,{error:'RULE_DECISION_INVALID',message:'Решение изменилось. Обновите страницу.'});
  rulesApplyCalls+=1;rulesApplied=true;lastRuleDecision=decision;return sendJSON(response,200,rulesResult());
 }
 if(url.pathname==='/api/support/errors')return sendJSON(response,200,{ok:true,errors:[]});
 if(url.pathname==='/api/modules/open'){
  const body=await requestBody(request);
  if(body.module_id==='correction-files-engine'){
   if(scenario!=='rules-sporno'||!rulesApplied||body.run_id!=='RUN-FIXTURE-1')return sendJSON(response,409,{error:'R001_NOT_READY',message:'Сначала примените решения правил.'});
   r001OpenCalls+=1;return sendJSON(response,200,{ok:true,run_id:'RUN-FIXTURE-1',ui_ready:true,message:'R001 открыт с черновиками «СПОРНО».',posting_rows:0,ready_to_upload:false,release_allowed:false,live_1c_allowed:false});
  }
  if(body.module_id!=='reconciliation-engine'||body.resolve_source_proof!==true||typeof body.business_action_id!=='string'||!body.business_action_id)return sendJSON(response,409,{error:'SOURCES_NOT_READY',message:'Источники не готовы.',run_id:null,posting_rows:0,ready_to_upload:false,release_allowed:false,live_1c_allowed:false});
  if(acceptedActions.has(body.business_action_id))return sendJSON(response,200,{ok:true,run_id:acceptedActions.get(body.business_action_id),ui_ready:true,message:'Запуск R005 уже принят.',posting_rows:0,ready_to_upload:false,release_allowed:false,live_1c_allowed:false});
  const blocked=readiness();if(!blocked.ready)return sendJSON(response,409,{error:'SOURCES_NOT_READY',message:blocked.message,run_id:null,posting_rows:0,ready_to_upload:false,release_allowed:false,live_1c_allowed:false});
  preflightCalls+=1;
  confirmCalls+=1;
  if(scenario==='drift')return sendJSON(response,409,{error:'SOURCES_NOT_READY',message:'Источник изменился во время проверки. Выберите пакет заново.',run_id:null,posting_rows:0,ready_to_upload:false,release_allowed:false,live_1c_allowed:false});
  runs+=1;const runID=`RUN-FIXTURE-${runs}`;acceptedActions.set(body.business_action_id,runID);return sendJSON(response,200,{ok:true,run_id:runID,ui_ready:true,message:'Сверка R005 запущена.',posting_rows:0,ready_to_upload:false,release_allowed:false,live_1c_allowed:false});
 }
 const relative=url.pathname==='/'?'index.html':url.pathname.replace(/^\//,'');if(!['index.html','app.js','app.css'].includes(relative)){response.writeHead(404);return response.end('not found')}
 try{const data=await readFile(join(root,relative));const type={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[extname(relative)];response.writeHead(200,{'Content-Type':type,'Content-Length':data.length,'Cache-Control':'no-store'});response.end(data)}catch(error){sendJSON(response,500,{error:error.message})}
});
server.listen(port,host,()=>process.stdout.write(`READY http://${host}:${port}\n`));
