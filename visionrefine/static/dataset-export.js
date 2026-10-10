/* Capabilities -> fixed snapshot preflight -> durable background jobs. */
let exportSession = {projectId:null, preview:null, generation:0, presets:[]};
let exportPoll = null;
const exportStates = {queued:"排队",running:"导出中",completed:"完成",partial:"部分成功",failed:"失败",cancelled:"已取消",interrupted:"服务重启中断"};

function invalidateExport() {
  exportSession.preview = null;
  exportSession.optionsDirty = true;
  exportSession.generation++;
  $("confirmExport").disabled = true;
  $("exportPreflight").hidden = true;
  $("exportDownload").hidden = true;
}

function setExportSplits(values) {
  const selected = new Set(values.length ? values : [""]);
  [...$("exportSplit").options].forEach(option => option.selected = selected.has(option.value));
  $("exportSplitPicker").querySelectorAll("input").forEach(input => { input.checked = selected.has(input.value); });
}

$("exportSplitPicker").onchange = event => {
  const input = event.target.closest("input");
  if (!input) return;
  const checked = [...$("exportSplitPicker").querySelectorAll("input:checked")].map(item => item.value);
  if (input.value === "" && input.checked) setExportSplits([""]);
  else setExportSplits(checked.filter(Boolean));
  invalidateExport();
};

function renderExportCenter() {
  if (!current) return;
  if (exportSession.projectId !== current.id) {
    exportSession = {projectId:current.id, preview:null, generation:exportSession.generation+1, presets:[]};
    $("exportPreflight").hidden = true;
    loadExportPresets();
  }
  const catalogKey=datasetFormats.map(f=>`${f.id}:${f.version}`).join("|");
  if(exportSession.catalogKey!==catalogKey){
    exportSession.catalogKey=catalogKey;
    $("extraExportFormats").innerHTML = datasetFormats.filter(f=>f.can_export).map(f=>{
      const supported=f.tasks.includes(current.task);
      return `<label class="export-format-option"><input type="checkbox" data-export-format="${escapeHtml(f.id)}" ${supported?"":"disabled"}><span>${escapeHtml(f.title)} · ${escapeHtml(f.version)} · ${escapeHtml(f.status)}<small>${escapeHtml(supported?f.limitations.join(" "):"当前任务尚无此格式的适配器")}</small></span></label>`;
    }).join("");
    $("extraExportFormats").onchange=invalidateExport;
  }
  refreshExportJobs();
}

function exportOptions() {
  return {formats:[...new Set([$("exportFormat").value,...[...$("extraExportFormats").querySelectorAll("input:checked:not(:disabled)")].map(i=>i.dataset.exportFormat)])],
    policy:$("exportPolicy").value,splits:[...$("exportSplit").selectedOptions].map(o=>o.value).filter(Boolean),include_images:$("exportImages").value==="true"};
}

function updateExportConfirmation() {
  $("confirmExport").disabled=!exportSession.preview || exportSession.preview.formats.some(f=>f.blocked) ||
    [...$("exportPreflightFormats").querySelectorAll("input[data-ack-format]")].some(i=>!i.checked);
}

async function previewExportCenter() {
  if(!current)return;
  if(editor.dirty&&!$("annotationWorkspace").hidden){$("exportStatus").textContent="请先保存人工修改，再检查导出。";return;}
  invalidateExport();
  const id=current.id,generation=exportSession.generation;
  $("exportDataset").disabled=true;
  $("exportStatus").textContent="正在核对图片内容、固定标注快照并检查兼容性…";
  try {
    const preview=await api(`/api/projects/${id}/dataset/export/preview`,{method:"POST",body:JSON.stringify(exportOptions())});
    if(current?.id!==id||generation!==exportSession.generation)return;
    exportSession.preview=preview;
    $("exportPreflight").hidden=false;
    $("exportPreflightSummary").textContent=`${preview.image_count} 张图片 / ${preview.object_count} ${current.task==="instance_segmentation"?"个实例":"个框"} / ${preview.category_count} 类；划分 ${Object.entries(preview.splits).map(([s,n])=>`${s}:${n}`).join(" · ")}。${preview.snapshot_note}`;
    $("exportPreflightFormats").innerHTML=preview.formats.map(f=>`<section><h4>${escapeHtml(datasetFormats.find(a=>a.id===f.format)?.title||f.format)}</h4><p>保留：${escapeHtml(f.preserved.join("、"))}</p>${f.issues.map(i=>`<label class="export-issue ${escapeHtml(i.severity)}">${i.requires_ack?`<input type="checkbox" data-ack-format="${escapeHtml(f.format)}" data-ack-code="${escapeHtml(i.code)}">`:""}<span>${escapeHtml(i.message)} ${i.count>1?`（${i.count} 项）`:""}${i.examples.length?`<small>${escapeHtml(i.examples.join("、"))}</small>`:""}${i.requires_ack?" 我已了解并允许此项转换。":""}</span></label>`).join("")}</section>`).join("");
    $("exportPreflightFormats").onchange=updateExportConfirmation;
    updateExportConfirmation();
    $("exportStatus").textContent=preview.formats.some(f=>f.blocked)?"存在阻止导出的项目，请修正后重新预览。":"逐项核对并确认需要的转换，再提交后台导出。";
  }catch(error){if(current?.id===id)$("exportStatus").textContent=error.message;}
  finally{if(current?.id===id)$("exportDataset").disabled=false;}
}

$("confirmExport").onclick=async()=>{
  const preview=exportSession.preview,id=current?.id;
  if(!preview||!id||$("confirmExport").disabled)return;
  const acknowledgements={};
  $("exportPreflightFormats").querySelectorAll("input:checked").forEach(i=>(acknowledgements[i.dataset.ackFormat]||=[]).push(i.dataset.ackCode));
  $("confirmExport").disabled=true;
  try{
    const job=await api(`/api/projects/${id}/dataset/export/jobs`,{method:"POST",body:JSON.stringify({preview_id:preview.preview_id,acknowledgements})});
    if(current?.id!==id)return;
    $("exportPreflight").hidden=true;exportSession.preview=null;exportSession.expectedJob=job.job_id;exportSession.optionsDirty=false;
    $("exportStatus").textContent="后台任务已提交，可以继续标注或刷新页面。";
    await refreshExportJobs();
  }catch(error){$("exportStatus").textContent=error.message;updateExportConfirmation();}
};

async function refreshExportJobs() {
  clearTimeout(exportPoll);
  if(!current||$("projectView").hidden)return;
  const id=current.id;
  try{
    const jobs=await api(`/api/projects/${id}/dataset/export/jobs`);
    if(current?.id!==id)return;
    $("exportJobs").innerHTML=jobs.slice(0,20).map(j=>`<section class="export-job"><div>${escapeHtml(j.created_at)} · ${escapeHtml(exportStates[j.status]||j.status)} <small>快照 ${escapeHtml(j.snapshot_at)}</small></div>${Object.entries(j.formats).map(([f,r])=>`<div>${escapeHtml(f)}：${escapeHtml(exportStates[r.status]||r.status)} · ${r.completed_images}/${r.total_images} ${r.error?escapeHtml(r.error):""} ${r.report?`<a href="${escapeHtml(r.report.download_url)}">下载此格式</a>`:""}</div>`).join("")}${j.error?`<p>${escapeHtml(j.error)}</p>`:""}${j.download_url?`<a href="${escapeHtml(j.download_url)}">下载本批全部成功包</a>`:""} <button class="secondary" data-job="${j.job_id}" data-action="${["queued","running"].includes(j.status)?"cancel":"retry"}">${["queued","running"].includes(j.status)?"取消未完成任务":"重试同一快照（全部格式）"}</button></section>`).join("")||"暂无导出任务。";
    $("exportJobs").querySelectorAll("button[data-job]").forEach(button=>button.onclick=async()=>{
      button.disabled=true;
      try{
        const job=await api(`/api/projects/${id}/dataset/export/jobs/${button.dataset.job}/${button.dataset.action}`,{method:"POST"});
        if(current?.id===id&&button.dataset.action==="retry"){exportSession.expectedJob=job.job_id;exportSession.optionsDirty=false;}
        await refreshExportJobs();
      }
      catch(error){$("exportStatus").textContent=error.message;button.disabled=false;}
    });
    const latest=jobs[0];
    if(latest&&!exportSession.optionsDirty&&(!exportSession.expectedJob||latest.job_id===exportSession.expectedJob)&&["completed","partial"].includes(latest.status)){
      const reports=Object.values(latest.formats).filter(r=>r.report).map(r=>r.report);
      $("exportDownload").href=reports.length===1?reports[0].download_url:latest.download_url;
      $("exportDownload").hidden=!$("exportPreflight").hidden;
    }else{$("exportDownload").hidden=true;}
    if(jobs.some(j=>["queued","running"].includes(j.status)))exportPoll=setTimeout(refreshExportJobs,1000);
  }catch(error){if(current?.id===id)$("exportJobs").textContent=error.message;}
}

async function loadExportPresets(){
  const id=current?.id;if(!id)return;
  try{
    const presets=await api(`/api/projects/${id}/dataset/export/presets`);if(current?.id!==id)return;
    exportSession.presets=presets;
    $("exportPreset").innerHTML='<option value="">选择预设</option>'+presets.map((p,i)=>`<option value="${i}">${escapeHtml(p.name)}</option>`).join("");
  }catch(error){$("exportStatus").textContent=error.message;}
}
$("saveExportPreset").onclick=async()=>{
  if(!current)return;
  const name=$("exportPresetName").value.trim();if(!name){$("exportStatus").textContent="请填写预设名称。";return;}
  try{await api(`/api/projects/${current.id}/dataset/export/presets`,{method:"POST",body:JSON.stringify({name,options:exportOptions()})});await loadExportPresets();$("exportStatus").textContent="预设已保存（不保存转换确认，实际导出仍需检查）。";}
  catch(error){$("exportStatus").textContent=error.message;}
};
$("exportPreset").onchange=()=>{
  if($("exportPreset").value==="")return;
  const p=exportSession.presets[Number($("exportPreset").value)].options;
  $("exportFormat").value=p.formats[0];$("exportPolicy").value=p.policy;$("exportImages").value=String(p.include_images);
  setExportSplits(p.splits);
  $("extraExportFormats").querySelectorAll("input").forEach(i=>i.checked=p.formats.slice(1).includes(i.dataset.exportFormat));invalidateExport();
};
$("datasetExportForm").addEventListener("change",invalidateExport);
