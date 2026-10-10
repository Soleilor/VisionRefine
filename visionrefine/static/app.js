const $ = (id) => document.getElementById(id);
let projects = [];
let current = null;
let projectNavigation = 0;
let editorLoadSequence = 0;
let editorLoadController = null;
let createLabels = ["person"];
let currentLabels = [];
let datasetFormats = [];
const detectionLabelOptions = [
  ["person", "行人"], ["vehicle", "车辆（合并类）"], ["car", "小汽车"], ["bus", "公交车"],
  ["truck", "卡车"], ["motorcycle", "摩托车"], ["bicycle", "自行车"], ["traffic light", "交通灯"],
  ["stop sign", "停车标志"], ["fire hydrant", "消防栓"], ["bench", "长椅"], ["backpack", "背包"],
  ["umbrella", "雨伞"], ["handbag", "手提包"], ["suitcase", "行李箱"], ["dog", "狗"]
];
const categoryColors = [
  "#d84a3a", "#1677c8", "#d96c0b", "#7657c7", "#13856f", "#bd3d78",
  "#587c18", "#087f91", "#95551a", "#5266bd", "#a43f4b", "#32765a"
];
const editor = {
  images: [], image: null, meta: null, objects: [], selected: -1,
  view: {x: 0, y: 0, width: 2048, height: 2048}, thumbnail: new Image(), crop: new Image(),
  cropView: null, cropToken: 0, cropTimer: null, interaction: null, spacePressed: false, dirty: false,
  annotationStatus: "unreviewed", initialJob: null, tool: "draw"
};

const taskNames = {
  video: "视频标注",
  detection: "目标检测", instance_segmentation: "实例分割", grounding: "视觉定位",
  captioning: "图像描述", vqa: "视觉问答", ocr: "OCR", classification: "图像分类"
};
const routeNames = {
  direct: "直接输入", resize_whole: "整图缩放", overlap_tiles: "重叠切片",
  annotation_crops: "粗标注引导裁剪"
};
const labeledTasks = new Set(["detection", "instance_segmentation", "grounding", "classification"]);

function normalizeLabel(value) {
  return String(value).trim().replace(/\s+/g, " ");
}

function categoryColor(label) {
  const value = String(label || "未分类");
  const labels = currentLabels.length ? currentLabels : (current?.labels || []);
  const knownIndex = labels.indexOf(value);
  if (knownIndex >= 0) return categoryColors[knownIndex % categoryColors.length];
  let hash = 0;
  for (const character of value) hash = ((hash * 31) + character.codePointAt(0)) >>> 0;
  return categoryColors[hash % categoryColors.length];
}

function renderLabelChips(targetId, labels, removeLabel, locked = false) {
  const target = $(targetId);
  target.innerHTML = "";
  labels.forEach(label => {
    const chip = document.createElement("span");
    chip.className = "label-chip";
    const text = document.createElement("span");
    text.textContent = label;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `删除标签 ${label}`);
    remove.textContent = "×";
    remove.hidden = locked;
    remove.onclick = () => removeLabel(label);
    chip.append(text, remove);
    target.appendChild(chip);
  });
}

function renderLabelChoices(targetId, selected, onToggle, disabled = false) {
  const target = $(targetId);
  target.innerHTML = "";
  detectionLabelOptions.forEach(([value, description]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `label-choice${selected.includes(value) ? " selected" : ""}`;
    button.disabled = disabled;
    button.setAttribute("aria-pressed", selected.includes(value) ? "true" : "false");
    const name = document.createElement("strong");
    name.textContent = value;
    const detail = document.createElement("small");
    detail.textContent = description;
    button.append(name, detail);
    button.onclick = () => onToggle(value);
    target.appendChild(button);
  });
}

function addLabel(inputId, labels, render) {
  const input = $(inputId);
  const label = normalizeLabel(input.value);
  if (!label || labels.includes(label)) return;
  labels.push(label);
  input.value = "";
  render();
  input.focus();
}

async function api(path, options = {}) {
  const response = await fetch(path, {headers: {"Content-Type": "application/json"}, ...options});
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = {detail: text || `HTTP ${response.status}`}; }
  if (!response.ok) throw new Error(data.detail || `请求失败（HTTP ${response.status}）`);
  return data;
}

async function loadProjects() {
  projects = await api("/api/projects");
  renderProjectList();
}

function renderProjectList() {
  const list = $("projectList");
  list.innerHTML = "";
  if (!projects.length) list.innerHTML = '<div class="empty">还没有项目</div>';
  projects.forEach(project => {
    const row = document.createElement("div");
    row.className = "project-row" + (current?.id === project.id ? " active" : "");
    const button = document.createElement("button");
    button.className = "project-item";
    button.innerHTML = `<strong>${escapeHtml(project.name)}</strong><small>${taskNames[project.task] || project.task}</small>`;
    button.onclick = () => showProject(project.id);
    const remove = document.createElement("button");
    remove.className = "project-delete";
    remove.setAttribute("aria-label", `删除项目 ${project.name}`);
    remove.title = "删除项目";
    remove.textContent = "×";
    remove.onclick = () => deleteProject(project);
    row.append(button, remove);
    list.appendChild(row);
  });
}

async function deleteProject(project) {
  const accepted = confirm(`删除项目“${project.name}”？\n\n只删除 VisionRefine 项目记录，不会删除原始图像和标注文件。`);
  if (!accepted) return;
  try {
    await api(`/api/projects/${project.id}`, {method: "DELETE"});
    projects = projects.filter(item => item.id !== project.id);
    if (current?.id === project.id) showCreate(true);
    else renderProjectList();
  } catch (error) {
    alert(`删除失败：${error.message}`);
  }
}

function confirmLeavingSegmentation() {
  return $("annotationWorkspace").hidden || confirmImageChange();
}

function showCreate(force = false) {
  if (force !== true && !confirmLeavingSegmentation()) return;
  projectNavigation++;
  resetImageBrowsers();
  current = null;
  $("createView").hidden = false;
  $("projectView").hidden = true;
  $("pageTitle").textContent = "创建标注项目";
  $("pageSubtitle").textContent = "导入数据后，系统会自动制定模型输入策略。";
  renderCreateLabels();
  renderProjectList();
}

async function showProject(id) {
  if (!confirmLeavingSegmentation()) return;
  const navigation = ++projectNavigation;
  let project;
  try { project = await api(`/api/projects/${id}`); }
  catch (error) { if (navigation === projectNavigation) alert(`项目加载失败：${error.message}`); return; }
  if (navigation !== projectNavigation) return;
  if (project.task === "video") {
    window.location.assign(`/video?project=${encodeURIComponent(id)}`);
    return;
  }
  resetImageBrowsers();
  current = await api(`/api/projects/${id}`);
  $("annotationWorkspace").hidden = true;
  $("exportStatus").textContent = "";
  $("exportDownload").hidden = true;
  $("importReport").hidden = true;
  $("datasetHistory").hidden = true;
  $("createView").hidden = true;
  $("projectView").hidden = false;
  $("pageTitle").textContent = current.name;
  $("pageSubtitle").textContent = `${taskNames[current.task]} · 模型输入上限 ${current.model_max_side}px`;
  renderProjectList();
  renderAnalysis();
  await loadImagePage("project");
  if (navigation !== projectNavigation) return;
  if (current.latest_suggestion) {
    api(`/api/projects/${id}/suggestions/latest`).then(result => {
      if (navigation === projectNavigation) showPilotResult(result, false);
    }).catch(() => {});
  } else {
    $("pilotPanel").hidden = true;
  }
}

function renderAnalysis() {
  renderDatasetIO();
  const a = current.analysis;
  $("openWorkspace").disabled = !a;
  $("startAI").hidden = current.task === "instance_segmentation";
  $("runPilot").hidden = current.task === "instance_segmentation";
  $("runPilot").disabled = !a || !current.ai_adapter;
  if (!a) {
    for (const id of ["statImages", "statMP", "statSize", "statCoarse"]) $(id).textContent = "—";
    $("routeBars").replaceChildren(); $("pipeline").replaceChildren();
    currentLabels = [...current.labels]; renderCurrentLabels();
    return;
  }
  $("statImages").textContent = a.image_count.toLocaleString();
  $("statMP").textContent = `${a.average_megapixels} MP`;
  $("statSize").textContent = `${a.max_width} × ${a.max_height}`;
  $("statCoarse").textContent = a.has_coarse_annotations ? "已接入" : "无";
  currentLabels = [...(current.labels?.length ? current.labels : ["person"])];
  renderCurrentLabels();

  const max = Math.max(...Object.values(a.routes), 1);
  $("routeBars").innerHTML = Object.entries(a.routes).map(([name, count]) => `
    <div class="route-row"><span>${routeNames[name] || name}</span><div class="bar-track"><div class="bar-fill" style="width:${count / max * 100}%"></div></div><strong>${count}</strong></div>
  `).join("");

  const steps = current.task === "instance_segmentation" ? [
    ["数据分析", "已完成", true],
    ["实例轮廓精修", "打开工作台绘制、改点或涂改掩码", false],
    ["人工版本保存", current.status === "human_reviewed" ? "已有保存版本" : "等待人工确认", current.status === "human_reviewed"]
  ] : [
    ["数据分析", "已完成", true],
    [a.has_coarse_annotations ? "AI 粗标注精修" : "AI 初始标注", current.ai_adapter ? `已配置 ${current.ai_adapter.model}` : "等待配置模型", false],
    ["查漏补缺", "未开始", false], ["人工检查", "未开始", false], ["AI 最终复核", "未开始", false]
  ];
  $("pipeline").innerHTML = steps.map((s, i) => `<div class="pipeline-step ${s[2] ? "done" : ""}"><span>${s[2] ? "✓" : i + 1}</span><div><strong>${s[0]}</strong><small>${s[1]}</small></div></div>`).join("");
  $("startAI").hidden = current.task === "instance_segmentation";
  $("runPilot").hidden = current.task === "instance_segmentation";
  $("runPilot").disabled = !current.ai_adapter;
  $("runPilot").title = current.ai_adapter ? "对首张图像的中心切片运行一次 AI 检测" : "请先配置 AI 适配器";
  $("runInitialDetection").disabled = !current.ai_adapter;
  $("runInitialDetection").title = current.ai_adapter ? "用重叠切片扫描工作台中当前选择的整张图像" : "请先配置 AI 适配器";
}

async function analyze(id) {
  if (!confirmLeavingSegmentation()) return;
  const navigation = projectNavigation;
  const button = $("reanalyze");
  button.disabled = true;
  button.textContent = "分析中…";
  try {
    const project = await api(`/api/projects/${id}/analyze`, {method: "POST"});
    if (navigation !== projectNavigation || current?.id !== id) return;
    current = project;
    resetImageBrowsers();
    $("annotationWorkspace").hidden = true;
    projects = projects.map(p => p.id === current.id ? current : p);
    renderAnalysis(); renderProjectList();
    await loadImagePage("project");
  } catch (error) {
    if (navigation === projectNavigation) $("projectImageStatus").textContent = `分析失败：${error.message}`;
  } finally {
    button.disabled = false; button.textContent = "重新分析";
  }
}

$("projectForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (openDatasetImport(false)) await previewDatasetImport();
});

$("newProject").onclick = showCreate;
$("reanalyze").onclick = () => current && analyze(current.id);
$("startAI").onclick = openAdapterDialog;
$("runPilot").onclick = runPilot;
$("openWorkspace").onclick = openAnnotationWorkspace;
$("saveLabels").onclick = saveProjectLabels;
$("closeAdapter").onclick = () => $("adapterDialog").close();

async function saveProjectLabels() {
  if (!current) return;
  const labels = [...currentLabels];
  const status = $("pilotStatus");
  if (!labels.length) {
    status.textContent = "请至少填写一个标签。";
    return;
  }
  try {
    current = await api(`/api/projects/${current.id}/labels`, {method: "PUT", body: JSON.stringify({labels})});
    projects = projects.map(project => project.id === current.id ? current : project);
    renderAnalysis();
    status.textContent = `标签已保存：${labels.join(", ")}`;
  } catch (error) {
    status.textContent = `标签保存失败：${error.message}`;
  }
}

$("projectForm").elements.task.addEventListener("change", event => {
  $("labelsField").hidden = !labeledTasks.has(event.target.value);
  renderCreateLabels();
  renderImportFormats();
});

function renderCreateLabels() {
  const detection = $("projectForm").elements.task.value === "detection";
  renderLabelChips("createLabelChips", createLabels, label => {
    createLabels = createLabels.filter(item => item !== label);
    renderCreateLabels();
  });
  renderLabelChoices("createLabelChoices", createLabels, label => {
    createLabels = createLabels.includes(label) ? createLabels.filter(item => item !== label) : [...createLabels, label];
    renderCreateLabels();
  });
  $("createLabelChoices").hidden = !detection;
  $("customCreateLabelRow").hidden = false;
  $("customCreateLabelRow").style.display = "grid";
}

function renderCurrentLabels() {
  const locked = Boolean(current?.labels_locked);
  const detection = current?.task === "detection";
  renderLabelChips("currentLabelChips", currentLabels, label => {
    if (locked) return;
    currentLabels = currentLabels.filter(item => item !== label);
    renderCurrentLabels();
  }, locked);
  renderLabelChoices("currentLabelChoices", currentLabels, label => {
    if (locked) return;
    currentLabels = currentLabels.includes(label) ? currentLabels.filter(item => item !== label) : [...currentLabels, label];
    renderCurrentLabels();
  }, locked);
  $("currentLabelChoices").hidden = locked || !detection;
  $("customCurrentLabelRow").hidden = locked;
  $("customCurrentLabelRow").style.display = locked ? "none" : "grid";
  $("saveLabels").hidden = locked;
  $("labelSchemaStatus").textContent = locked ? "标签集合已锁定，AI 和人工只能使用这些标签。" : "导入标注、推理或人工保存前可以调整标签集合。";
}

$("addProjectLabel").onclick = () => addLabel("newProjectLabel", createLabels, renderCreateLabels);
$("addCurrentLabel").onclick = () => addLabel("newCurrentLabel", currentLabels, renderCurrentLabels);
$("newProjectLabel").addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); addLabel("newProjectLabel", createLabels, renderCreateLabels); }
});
$("newCurrentLabel").addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); addLabel("newCurrentLabel", currentLabels, renderCurrentLabels); }
});

async function runPilot() {
  if (!current?.ai_adapter) return openAdapterDialog();
  const button = $("runPilot");
  const status = $("pilotStatus");
  button.disabled = true;
  button.textContent = "Qwen 正在分析…";
  status.textContent = "正在提取一个原分辨率切片并生成 AI 建议。";
  try {
    const result = await api(`/api/projects/${current.id}/pilot`, {method: "POST"});
    current = await api(`/api/projects/${current.id}`);
    projects = projects.map(project => project.id === current.id ? current : project);
    renderAnalysis();
    showPilotResult(result);
    status.textContent = `已保存建议版本 ${result.revision_id}`;
  } catch (error) {
    status.textContent = `测试失败：${error.message}`;
  } finally {
    button.disabled = !current?.ai_adapter;
    button.textContent = "运行单切片测试";
  }
}

function showPilotResult(result, shouldScroll = true) {
  $("pilotPanel").hidden = false;
  $("pilotMeta").textContent = `${result.image} · 原图坐标 (${result.crop.x}, ${result.crop.y}) · ${result.model}`;
  $("pilotSummary").textContent = result.summary || "模型未提供摘要。";
  $("pilotObjects").innerHTML = result.objects.length ? result.objects.map((object, index) => `
    <div class="pilot-object"><strong>${escapeHtml(object.label)} ${index + 1}</strong><span>${Math.round(object.confidence * 100)}%</span></div>
  `).join("") : '<div class="empty">该切片没有人物建议框</div>';
  const canvas = $("pilotCanvas");
  const context = canvas.getContext("2d");
  const image = new Image();
  image.onload = () => {
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    context.drawImage(image, 0, 0);
    context.font = "500 18px system-ui";
    result.objects.forEach((object, index) => {
      const [x1, y1, x2, y2] = object.bbox;
      const localX = x1 - result.crop.x, localY = y1 - result.crop.y;
      const width = x2 - x1, height = y2 - y1;
      const color = categoryColor(object.label);
      context.strokeStyle = color;
      context.lineWidth = 4;
      context.strokeRect(localX, localY, width, height);
      const label = `${object.label} ${index + 1}`;
      const labelWidth = context.measureText(label).width + 12;
      context.fillStyle = color;
      context.fillRect(localX, Math.max(0, localY - 25), labelWidth, 25);
      context.fillStyle = "#ffffff";
      context.fillText(label, localX + 6, Math.max(19, localY - 6));
    });
  };
  image.src = result.crop_url + `?v=${encodeURIComponent(result.revision_id)}`;
  if (shouldScroll) $("pilotPanel").scrollIntoView({behavior: "smooth", block: "start"});
}

function encodedPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function canvasFit(canvas, width, height) {
  const scale = Math.min(canvas.width / width, canvas.height / height);
  return {scale, x: (canvas.width - width * scale) / 2, y: (canvas.height - height * scale) / 2};
}

function canvasPoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return [(event.clientX - rect.left) * canvas.width / rect.width, (event.clientY - rect.top) * canvas.height / rect.height];
}

async function openAnnotationWorkspace() {
  if (!current) return;
  Segmentation.configure();
  const panel = $("annotationWorkspace");
  if (!panel.hidden) { panel.scrollIntoView({behavior: "smooth"}); return; }
  panel.hidden = false;
  $("workspaceStatus").textContent = "正在载入图像列表…";
  $("workspaceLabel").innerHTML = (current.labels?.length ? current.labels : ["person"]).map(label => `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`).join("");
  await loadImagePage("workspace");
  panel.scrollIntoView({behavior: "smooth", block: "start"});
}

function setEditorLoading(loading) {
  editor.loading = loading;
  $("annotationWorkspace").querySelector(".viewer-grid").inert = loading;
  $("annotationWorkspace").querySelector(".editor-tools").inert = loading;
  $("segmentationTools").inert = loading;
  $("segmentationOperations").inert = loading;
  $("workspaceLabel").disabled = loading;
  $("saveAnnotations").disabled = loading || !editor.image;
  $("workspaceImage").disabled = loading || !editor.images.length;
}

function cancelEditorLoad() {
  editorLoadSequence++;
  editorLoadController?.abort();
  clearTimeout(editor.cropTimer);
  editor.cropToken++;
  setEditorLoading(false);
}

async function loadEditorImage(path, meta = editor.images.find(row => row.path === path)) {
  cancelEditorLoad();
  const sequence = editorLoadSequence, projectId = current.id;
  const controller = editorLoadController = new AbortController();
  const active = () => sequence === editorLoadSequence && current?.id === projectId;
  setEditorLoading(true);
  $("workspaceStatus").textContent = "正在加载图像与标注…";
  try {
    const annotation = await api(`/api/projects/${projectId}/annotations?image=${encodeURIComponent(path)}`, {signal: controller.signal});
    if (!active()) return false;
    const thumbnail = new Image();
    await new Promise((resolve, reject) => {
      const abort = () => { thumbnail.src = ""; reject(new DOMException("Cancelled", "AbortError")); };
      thumbnail.onload = () => { controller.signal.removeEventListener("abort", abort); resolve(); };
      thumbnail.onerror = () => { controller.signal.removeEventListener("abort", abort); reject(new Error("缩略图加载失败")); };
      controller.signal.addEventListener("abort", abort, {once: true});
      thumbnail.src = `/api/projects/${projectId}/thumbnail/${encodedPath(path)}`;
    });
    if (!active()) return false;
    Segmentation.reset();
    closeBoxLabelPanel();
    editor.image = path;
    editor.meta = meta;
    editor.thumbnail = thumbnail;
    editor.selected = -1;
    editor.interaction = null;
    editor.dirty = false;
    editor.cropView = null;
    setEditorTool("draw");
    editor.view.width = editor.meta.width;
    editor.view.height = editor.meta.height;
    editor.view.x = 0;
    editor.view.y = 0;
    editor.objects = annotation.objects || [];
    editor.annotationStatus = annotation.status;
    Segmentation.sync();
    refreshEditorCrop();
    $("workspaceCurrentImage").textContent = `当前图像：${path}`;
    renderVideoFrameOrigin(projectId, path);
    $("workspaceStatus").textContent = `${annotation.status} · ${editor.objects.length} ${Segmentation.active() ? "个实例" : "个框"}`;
    updateDeleteButton();
    return true;
  } catch (error) {
    if (active() && error.name !== "AbortError") {
      $("workspaceStatus").textContent = `加载失败：${error.message}。可重新选择图像或点击跳转重试。`;
      $("workspaceImage").value = editor.image || "";
    }
    return false;
  } finally { if (active()) setEditorLoading(false); }
}

function clampEditorView() {
  const meta = editor.meta;
  if (!meta) return;
  editor.view.width = Math.max(Math.min(256, meta.width), Math.min(meta.width, Math.round(editor.view.width)));
  editor.view.height = Math.max(Math.min(256, meta.height), Math.min(meta.height, Math.round(editor.view.height)));
  editor.view.x = Math.max(0, Math.min(meta.width - editor.view.width, editor.view.x));
  editor.view.y = Math.max(0, Math.min(meta.height - editor.view.height, editor.view.y));
}

function refreshEditorCrop(delay = 0) {
  if (!editor.meta) return;
  clampEditorView();
  editor.view.x = Math.max(0, Math.min(editor.meta.width - editor.view.width, Math.round(editor.view.x / 16) * 16));
  editor.view.y = Math.max(0, Math.min(editor.meta.height - editor.view.height, Math.round(editor.view.y / 16) * 16));
  drawDetail();
  clearTimeout(editor.cropTimer);
  const token = ++editor.cropToken;
  if (editor.view.width > 4096 || editor.view.height > 4096) {
    editor.cropView = null;
    return;
  }
  const requested = {...editor.view};
  editor.cropTimer = setTimeout(() => {
    const image = new Image();
    image.onload = () => {
      if (token !== editor.cropToken) return;
      editor.crop = image;
      editor.cropView = requested;
      drawDetail();
    };
    image.src = `/api/projects/${current.id}/crop/${encodedPath(editor.image)}?x=${Math.round(requested.x)}&y=${Math.round(requested.y)}&width=${Math.round(requested.width)}&height=${Math.round(requested.height)}`;
  }, delay);
}

function drawDetail() {
  const canvas = $("detailCanvas"), context = canvas.getContext("2d"), view = editor.view;
  if (!editor.meta || !editor.thumbnail.naturalWidth) return;
  const fit = canvasFit(canvas, view.width, view.height);
  context.clearRect(0, 0, canvas.width, canvas.height);
  const thumb = editor.thumbnail, meta = editor.meta;
  context.drawImage(thumb,
    view.x / meta.width * thumb.naturalWidth, view.y / meta.height * thumb.naturalHeight,
    view.width / meta.width * thumb.naturalWidth, view.height / meta.height * thumb.naturalHeight,
    fit.x, fit.y, view.width * fit.scale, view.height * fit.scale);
  const ready = editor.cropView && ["x", "y", "width", "height"].every(key => Math.abs(editor.cropView[key] - view[key]) < 1);
  if (ready && editor.crop.naturalWidth) context.drawImage(editor.crop, fit.x, fit.y, view.width * fit.scale, view.height * fit.scale);
  editor.objects.forEach((object, index) => {
    const [x1, y1, x2, y2] = object.bbox;
    if (x2 < view.x || y2 < view.y || x1 > view.x + view.width || y1 > view.y + view.height) return;
    const screenX = fit.x + (x1 - view.x) * fit.scale;
    const screenY = fit.y + (y1 - view.y) * fit.scale;
    const screenWidth = (x2 - x1) * fit.scale;
    const screenHeight = (y2 - y1) * fit.scale;
    const color = categoryColor(object.label);
    if (Segmentation.active()) {
      Segmentation.drawObject(context, object, index, fit);
    } else {
    if (index === editor.selected) {
      context.strokeStyle = "#ffffff";
      context.lineWidth = 7;
      context.strokeRect(screenX, screenY, screenWidth, screenHeight);
    }
    context.strokeStyle = color;
    context.lineWidth = index === editor.selected ? 4 : 2;
    context.strokeRect(screenX, screenY, screenWidth, screenHeight);

    }

    // Keep labels attached to their boxes so both AI proposals and human boxes
    // remain identifiable while zooming and panning.
    const label = object.confidence == null
      ? String(object.label || "未分类")
      : `${object.label || "未分类"} ${Math.round(object.confidence * 100)}%`;
    const labelMetrics = labelMetricsFor(screenWidth, screenHeight);
    context.font = `600 ${labelMetrics.fontSize}px system-ui, sans-serif`;
    const labelWidth = Math.max(labelMetrics.minWidth, context.measureText(label).width + labelMetrics.paddingX * 2);
    const labelHeight = labelMetrics.fontSize + labelMetrics.paddingY * 2;
    const labelX = Math.max(0, Math.min(canvas.width - labelWidth, screenX));
    const labelY = screenY - labelHeight >= 0 ? screenY - labelHeight : screenY;
    context.fillStyle = color;
    context.fillRect(labelX, labelY, labelWidth, labelHeight);
    if (index === editor.selected) {
      context.strokeStyle = "#ffffff";
      context.lineWidth = 2;
      context.strokeRect(labelX + 1, labelY + 1, labelWidth - 2, labelHeight - 2);
    }
    context.fillStyle = "#ffffff";
    context.textBaseline = "middle";
    context.fillText(label, labelX + labelMetrics.paddingX, labelY + labelHeight / 2);
    context.textBaseline = "alphabetic";
  });
  if (Segmentation.active()) {
    Segmentation.drawHandles(context, fit);
    Segmentation.drawOverlay(context, fit);
    Segmentation.drawPreview(context, fit);
  } else if (editor.selected >= 0) drawSelectionHandles(context, fit);
  if (editor.interaction?.kind === "create") {
    context.strokeStyle = "#20e080"; context.lineWidth = 3; context.setLineDash([8, 5]);
    const drag = editor.interaction;
    const x1 = Math.min(drag.startX, drag.endX), y1 = Math.min(drag.startY, drag.endY);
    context.strokeRect(fit.x + (x1 - view.x) * fit.scale, fit.y + (y1 - view.y) * fit.scale, Math.abs(drag.endX - drag.startX) * fit.scale, Math.abs(drag.endY - drag.startY) * fit.scale);
    context.setLineDash([]);
  }
  if (!$("boxLabelPanel").hidden) positionBoxLabelPanel();
}

function labelHitAt(x, y) {
  const canvas = $("detailCanvas"), fit = canvasFit(canvas, editor.view.width, editor.view.height);
  const context = canvas.getContext("2d");
  context.font = "600 14px system-ui, sans-serif";
  for (let index = editor.objects.length - 1; index >= 0; index -= 1) {
    const object = editor.objects[index];
    const [x1, y1, x2, y2] = object.bbox;
    if (x2 < editor.view.x || y2 < editor.view.y || x1 > editor.view.x + editor.view.width || y1 > editor.view.y + editor.view.height) continue;
    const screenX = fit.x + (x1 - editor.view.x) * fit.scale;
    const screenY = fit.y + (y1 - editor.view.y) * fit.scale;
    const screenWidth = (x2 - x1) * fit.scale;
    const screenHeight = (y2 - y1) * fit.scale;
    const label = object.confidence == null
      ? String(object.label || "未分类")
      : `${object.label || "未分类"} ${Math.round(object.confidence * 100)}%`;
    const labelMetrics = labelMetricsFor(screenWidth, screenHeight);
    context.font = `600 ${labelMetrics.fontSize}px system-ui, sans-serif`;
    const width = Math.max(labelMetrics.minWidth, context.measureText(label).width + labelMetrics.paddingX * 2);
    const labelHeight = labelMetrics.fontSize + labelMetrics.paddingY * 2;
    const labelX = Math.max(0, Math.min(canvas.width - width, screenX));
    const labelY = screenY - labelHeight >= 0 ? screenY - labelHeight : screenY;
    if (x >= labelX && x <= labelX + width && y >= labelY && y <= labelY + labelHeight) return index;
  }
  return -1;
}

function labelMetricsFor(screenWidth, screenHeight) {
  // Every label dimension derives from the box's rendered size, so the text
  // and its background scale together with the box during zoom.
  const reference = Math.max(1, Math.min(screenHeight, screenWidth * 1.8));
  const fontSize = Math.max(4, Math.min(72, reference * 0.16));
  return {
    fontSize,
    paddingX: fontSize * 0.48,
    paddingY: fontSize * 0.28,
    minWidth: fontSize * 2.6,
  };
}

function selectedLabelRect() {
  const object = editor.selected >= 0 ? editor.objects[editor.selected] : null;
  if (!object) return null;
  const canvas = $("detailCanvas"), context = canvas.getContext("2d");
  const fit = canvasFit(canvas, editor.view.width, editor.view.height);
  const [x1, y1, x2, y2] = object.bbox;
  const x = fit.x + (x1 - editor.view.x) * fit.scale;
  const y = fit.y + (y1 - editor.view.y) * fit.scale;
  const screenWidth = (x2 - x1) * fit.scale;
  const screenHeight = (y2 - y1) * fit.scale;
  const text = object.confidence == null ? String(object.label || "未分类") : `${object.label || "未分类"} ${Math.round(object.confidence * 100)}%`;
  const metrics = labelMetricsFor(screenWidth, screenHeight);
  context.font = `600 ${metrics.fontSize}px system-ui, sans-serif`;
  const width = Math.max(metrics.minWidth, context.measureText(text).width + metrics.paddingX * 2);
  const height = metrics.fontSize + metrics.paddingY * 2;
  return {x: Math.max(0, Math.min(canvas.width - width, x)), y: y - height >= 0 ? y - height : y, width, height, fontSize: metrics.fontSize};
}

function selectEditorObject(index) {
  const panelWasOpen = !$("boxLabelPanel").hidden;
  editor.selected = index;
  updateDeleteButton();
  drawDetail();
  if (panelWasOpen) openBoxLabelPanel();
}

function changeSelectedLabel(label) {
  const object = editor.selected >= 0 ? editor.objects[editor.selected] : null;
  if (!object || !label) return;
  if (object.label !== label) {
    Segmentation.checkpoint();
    object.label = label;
    markEditorDirty();
  }
  setEditorTool("draw");
}

function closeBoxLabelPanel() {
  $("boxLabelPanel").hidden = true;
}

function openBoxLabelPanel() {
  const object = editor.selected >= 0 ? editor.objects[editor.selected] : null;
  if (!object) return closeBoxLabelPanel();
  const labelRect = selectedLabelRect();
  if (!labelRect) return closeBoxLabelPanel();
  const options = $("boxLabelOptions");
  options.innerHTML = "";
  Array.from($("workspaceLabel").options).forEach(option => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `box-label-option${option.value === object.label ? " selected" : ""}`;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", option.value === object.label ? "true" : "false");
    button.textContent = option.textContent;
    button.style.setProperty("--label-color", categoryColor(option.value));
    button.onclick = () => changeSelectedLabel(option.value);
    options.appendChild(button);
  });
  const palette = $("boxLabelPanel");
  palette.hidden = false;
  positionBoxLabelPanel();
}

function positionBoxLabelPanel() {
  const palette = $("boxLabelPanel"), labelRect = selectedLabelRect();
  if (palette.hidden || !labelRect) return;
  const canvas = $("detailCanvas"), section = canvas.parentElement;
  const canvasRect = canvas.getBoundingClientRect(), sectionRect = section.getBoundingClientRect();
  const scaleX = canvasRect.width / canvas.width, scaleY = canvasRect.height / canvas.height;
  palette.style.setProperty("--palette-font-size", `${Math.max(10, Math.min(18, labelRect.fontSize * scaleX))}px`);
  const anchorX = canvasRect.left - sectionRect.left + labelRect.x * scaleX;
  const anchorY = canvasRect.top - sectionRect.top + (labelRect.y + labelRect.height) * scaleY + 4;
  const paletteWidth = palette.offsetWidth, paletteHeight = palette.offsetHeight;
  palette.style.left = `${Math.max(4, Math.min(section.clientWidth - paletteWidth - 4, anchorX))}px`;
  palette.style.top = `${Math.max(34, Math.min(section.clientHeight - paletteHeight - 4, anchorY))}px`;
}

function selectionHandles(bbox) {
  const [x1, y1, x2, y2] = bbox, cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  return {nw:[x1,y1], n:[cx,y1], ne:[x2,y1], e:[x2,cy], se:[x2,y2], s:[cx,y2], sw:[x1,y2], w:[x1,cy]};
}

function drawSelectionHandles(context, fit) {
  const object = editor.objects[editor.selected];
  if (!object) return;
  context.fillStyle = categoryColor(object.label); context.strokeStyle = "#ffffff"; context.lineWidth = 2;
  Object.values(selectionHandles(object.bbox)).forEach(([x, y]) => {
    const px = fit.x + (x - editor.view.x) * fit.scale, py = fit.y + (y - editor.view.y) * fit.scale;
    context.fillRect(px - 5, py - 5, 10, 10); context.strokeRect(px - 5, py - 5, 10, 10);
  });
}

function detailImagePoint(event) {
  const canvas = $("detailCanvas"), fit = canvasFit(canvas, editor.view.width, editor.view.height), [x, y] = canvasPoint(event, canvas);
  return [editor.view.x + Math.max(0, Math.min(editor.view.width, (x - fit.x) / fit.scale)), editor.view.y + Math.max(0, Math.min(editor.view.height, (y - fit.y) / fit.scale))];
}

function selectedHandleAt(x, y) {
  const object = editor.objects[editor.selected];
  if (!object) return null;
  const fit = canvasFit($("detailCanvas"), editor.view.width, editor.view.height);
  const tolerance = 10 / fit.scale;
  let nearest = null, distance = Infinity;
  Object.entries(selectionHandles(object.bbox)).forEach(([name, point]) => {
    const candidate = Math.hypot(x - point[0], y - point[1]);
    if (candidate <= tolerance && candidate < distance) { nearest = name; distance = candidate; }
  });
  return nearest;
}

function objectHitAt(x, y) {
  const hits = editor.objects.map((object, index) => ({index, object})).filter(({object}) =>
    x >= object.bbox[0] && x <= object.bbox[2] && y >= object.bbox[1] && y <= object.bbox[3]
  );
  if (!hits.length) return -1;
  return hits.sort((a, b) =>
    ((a.object.bbox[2] - a.object.bbox[0]) * (a.object.bbox[3] - a.object.bbox[1])) -
    ((b.object.bbox[2] - b.object.bbox[0]) * (b.object.bbox[3] - b.object.bbox[1]))
  )[0].index;
}

function cursorForHandle(handle) {
  if (["nw", "se"].includes(handle)) return "nwse-resize";
  if (["ne", "sw"].includes(handle)) return "nesw-resize";
  if (["n", "s"].includes(handle)) return "ns-resize";
  if (["e", "w"].includes(handle)) return "ew-resize";
  return "crosshair";
}

function setEditorTool(tool) {
  if (Segmentation.active()) return Segmentation.setTool(tool);
  editor.tool = tool === "edit" ? "edit" : "draw";
  const drawing = editor.tool === "draw";
  $("drawBoxTool").classList.toggle("active", drawing);
  $("drawBoxTool").setAttribute("aria-pressed", drawing ? "true" : "false");
  $("editBoxTool").classList.toggle("active", !drawing);
  $("editBoxTool").setAttribute("aria-pressed", drawing ? "false" : "true");
  if (drawing) {
    editor.selected = -1;
    closeBoxLabelPanel();
    updateDeleteButton();
  }
  $("detailCanvas").style.cursor = drawing ? "crosshair" : "default";
  drawDetail();
}

function markEditorDirty() {
  editor.dirty = true;
  $("workspaceStatus").textContent = `未保存 · ${editor.objects.length} ${Segmentation.active() ? "个实例" : "个框"}`;
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function runInitialDetection() {
  if (!current?.ai_adapter || !editor.image || editor.initialJob || editor.loading) return;
  if (editor.dirty) {
    $("workspaceStatus").textContent = "请先保存或放弃当前人工修改，再运行 AI 初标。";
    return;
  }
  const estimated = editor.meta?.route?.estimated_tiles || "多";
  const message = editor.annotationStatus === "human_reviewed"
    ? `该图像已有人工保存结果。AI 将扫描约 ${estimated} 个切片并另存建议，不会覆盖人工结果。是否继续？`
    : `AI 将扫描当前整张图像的约 ${estimated} 个重叠切片，可能需要较长时间。是否开始？`;
  if (!confirm(message)) return;
  const projectId = current.id, imagePath = editor.image, imageMeta = editor.meta;
  const active = () => current?.id === projectId && editor.image === imagePath;
  const button = $("runInitialDetection"), status = $("workspaceStatus");
  button.disabled = true;
  button.textContent = "正在启动…";
  try {
    let job = await api(`/api/projects/${projectId}/initial-detection`, {
      method: "POST", body: JSON.stringify({image: imagePath})
    });
    editor.initialJob = job.job_id;
    while (["queued", "running"].includes(job.status)) {
      if (active()) status.textContent = `AI 初标 ${job.completed_tiles}/${job.total_tiles} · 已发现 ${job.candidate_count} 个候选框`;
      button.textContent = `${job.completed_tiles}/${job.total_tiles}`;
      await wait(1000);
      job = await api(`/api/projects/${projectId}/initial-detection/${job.job_id}`);
    }
    if (job.status === "failed") throw new Error(job.error || "AI 初标失败");
    if (!active()) return;
    if (editor.dirty || editor.loading) {
      status.textContent = "AI 建议已保存；当前编辑继续保留，可在保存后重新打开图像查看。";
      return;
    }
    const loaded = await loadEditorImage(imagePath, imageMeta);
    if (loaded && active()) status.textContent = `AI 初标完成 · ${job.candidate_count} 个框 · ${job.error_count || 0} 个切片失败`;
  } catch (error) {
    if (active()) status.textContent = `AI 初标失败：${error.message}`;
  } finally {
    editor.initialJob = null;
    button.disabled = !current?.ai_adapter;
    button.textContent = "AI 初标当前图像";
  }
}

$("runInitialDetection").onclick = runInitialDetection;
$("drawBoxTool").onclick = () => setEditorTool("draw");
$("editBoxTool").onclick = () => setEditorTool("edit");

$("detailCanvas").addEventListener("pointerdown", event => {
  if (Segmentation.active()) return Segmentation.pointerDown(event);
  const [x, y] = detailImagePoint(event);
  const [canvasX, canvasY] = canvasPoint(event, event.currentTarget);
  if (event.button === 2 || event.button === 1 || editor.spacePressed) {
    editor.interaction = {kind: "pan", clientX: event.clientX, clientY: event.clientY, viewX: editor.view.x, viewY: editor.view.y};
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.style.cursor = "grabbing";
    event.preventDefault();
    return;
  }
  const labeled = labelHitAt(canvasX, canvasY);
  if (labeled >= 0) {
    setEditorTool("edit");
    selectEditorObject(labeled);
    openBoxLabelPanel();
    return;
  }
  if (editor.tool === "draw") {
    const hitIndex = objectHitAt(x, y);
    selectEditorObject(-1);
    closeBoxLabelPanel();
    editor.interaction = {
      kind: "create", startX: x, startY: y, endX: x, endY: y,
      clientX: event.clientX, clientY: event.clientY, hitIndex
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    updateDeleteButton();
    drawDetail();
    return;
  }
  const handle = selectedHandleAt(x, y);
  if (handle) {
    editor.interaction = {kind: "resize", handle, startX: x, startY: y, bbox: [...editor.objects[editor.selected].bbox]};
    event.currentTarget.setPointerCapture(event.pointerId);
    return;
  }
  const selectedObject = editor.objects[editor.selected];
  if (selectedObject && x >= selectedObject.bbox[0] && x <= selectedObject.bbox[2] && y >= selectedObject.bbox[1] && y <= selectedObject.bbox[3]) {
    editor.interaction = {kind: "move", startX: x, startY: y, bbox: [...selectedObject.bbox]};
    event.currentTarget.setPointerCapture(event.pointerId);
    return;
  }
  const hitIndex = objectHitAt(x, y);
  if (hitIndex >= 0) {
    selectEditorObject(hitIndex);
    editor.interaction = null;
  } else {
    selectEditorObject(-1);
    closeBoxLabelPanel();
    editor.interaction = null;
  }
  updateDeleteButton(); drawDetail();
});

$("detailCanvas").addEventListener("pointermove", event => {
  if (Segmentation.active()) return Segmentation.pointerMove(event);
  const [x, y] = detailImagePoint(event), interaction = editor.interaction;
  if (!interaction) {
    const [canvasX, canvasY] = canvasPoint(event, event.currentTarget);
    if (labelHitAt(canvasX, canvasY) >= 0) {
      event.currentTarget.style.cursor = "pointer";
      return;
    }
    const handle = editor.tool === "edit" ? selectedHandleAt(x, y) : null;
    event.currentTarget.style.cursor = editor.spacePressed ? "grab" : (editor.tool === "draw" ? "crosshair" : (handle ? cursorForHandle(handle) : "default"));
    return;
  }
  if (interaction.kind === "create") {
    [interaction.endX, interaction.endY] = [x, y];
  } else if (interaction.kind === "pan") {
    const canvas = event.currentTarget, rect = canvas.getBoundingClientRect();
    const fit = canvasFit(canvas, editor.view.width, editor.view.height);
    editor.view.x = interaction.viewX - (event.clientX - interaction.clientX) * canvas.width / rect.width / fit.scale;
    editor.view.y = interaction.viewY - (event.clientY - interaction.clientY) * canvas.height / rect.height / fit.scale;
    clampEditorView();
  } else {
    const bbox = [...interaction.bbox], dx = x - interaction.startX, dy = y - interaction.startY;
    if (interaction.kind === "move") {
      const width = bbox[2] - bbox[0], height = bbox[3] - bbox[1];
      bbox[0] = Math.max(0, Math.min(editor.meta.width - width, bbox[0] + dx)); bbox[2] = bbox[0] + width;
      bbox[1] = Math.max(0, Math.min(editor.meta.height - height, bbox[1] + dy)); bbox[3] = bbox[1] + height;
    } else {
      if (interaction.handle.includes("w")) bbox[0] = Math.min(bbox[2] - 1, Math.max(0, x));
      if (interaction.handle.includes("e")) bbox[2] = Math.max(bbox[0] + 1, Math.min(editor.meta.width, x));
      if (interaction.handle.includes("n")) bbox[1] = Math.min(bbox[3] - 1, Math.max(0, y));
      if (interaction.handle.includes("s")) bbox[3] = Math.max(bbox[1] + 1, Math.min(editor.meta.height, y));
    }
    editor.objects[editor.selected].bbox = bbox;
  }
  drawDetail();
});

$("detailCanvas").addEventListener("pointerup", event => {
  if (Segmentation.active()) return Segmentation.pointerUp(event);
  const interaction = editor.interaction;
  if (!interaction) return;
  if (interaction.kind === "create") {
    [interaction.endX, interaction.endY] = detailImagePoint(event);
    const bbox = [Math.min(interaction.startX, interaction.endX), Math.min(interaction.startY, interaction.endY), Math.max(interaction.startX, interaction.endX), Math.max(interaction.startY, interaction.endY)];
    const dragged = Math.hypot(event.clientX - interaction.clientX, event.clientY - interaction.clientY) >= 4;
    if (dragged && bbox[2] - bbox[0] >= 3 && bbox[3] - bbox[1] >= 3) {
      editor.objects.push({id: `human-${Date.now()}`, label: $("workspaceLabel").value, bbox, confidence: null, source: "human"});
      // Leave creation mode ready for the next object. The new box can still
      // be selected by clicking its box or label, but its resize handles do
      // not intercept the next annotation drag.
      editor.selected = -1;
      markEditorDirty();
    } else if (interaction.hitIndex >= 0) {
      setEditorTool("edit");
      selectEditorObject(interaction.hitIndex);
    }
    event.currentTarget.style.cursor = "crosshair";
  } else if (["move", "resize"].includes(interaction.kind)) {
    markEditorDirty();
  } else if (interaction.kind === "pan") {
    refreshEditorCrop(80);
    event.currentTarget.style.cursor = "grab";
  }
  editor.interaction = null;
  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  updateDeleteButton(); drawDetail();
});

$("detailCanvas").addEventListener("pointercancel", event => {
  if (Segmentation.active()) return Segmentation.cancelInteraction(event);
  editor.interaction = null;
  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  event.currentTarget.style.cursor = "crosshair";
  drawDetail();
});
$("detailCanvas").addEventListener("contextmenu", event => event.preventDefault());
$("detailCanvas").addEventListener("wheel", event => {
  if (!editor.meta) return;
  event.preventDefault();
  const [anchorX, anchorY] = detailImagePoint(event);
  const factor = event.deltaY < 0 ? 0.92 : 1 / 0.92;
  const nextWidth = Math.max(Math.min(256, editor.meta.width), Math.min(editor.meta.width, editor.view.width * factor));
  const nextHeight = Math.max(Math.min(256, editor.meta.height), Math.min(editor.meta.height, editor.view.height * factor));
  const rx = (anchorX - editor.view.x) / editor.view.width, ry = (anchorY - editor.view.y) / editor.view.height;
  editor.view.x = anchorX - rx * nextWidth; editor.view.y = anchorY - ry * nextHeight;
  editor.view.width = nextWidth; editor.view.height = nextHeight;
  refreshEditorCrop(140);
}, {passive: false});

function deleteSelectedBox() {
  if (editor.loading) return;
  if (Segmentation.active()) return Segmentation.deleteObject();
  if (editor.selected < 0) return;
  editor.objects.splice(editor.selected, 1);
  editor.selected = -1;
  markEditorDirty();
  setEditorTool("draw");
}

function updateDeleteButton() { $("deleteBox").disabled = editor.selected < 0; Segmentation.sync(); }
$("deleteBox").onclick = deleteSelectedBox;
document.addEventListener("keydown", event => {
  if (editor.loading) return;
  if (event.code === "Space" && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    editor.spacePressed = true;
    if (!$("annotationWorkspace").hidden) event.preventDefault();
  }
  if (Segmentation.active() && !$("annotationWorkspace").hidden && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    Segmentation.keydown(event);
    return;
  }
  if (event.key === "Delete" && !$("annotationWorkspace").hidden && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) deleteSelectedBox();
  if (!$("annotationWorkspace").hidden && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    if (event.key.toLowerCase() === "n") setEditorTool("draw");
    if (event.key.toLowerCase() === "v") setEditorTool("edit");
  }
});
document.addEventListener("keyup", event => { if (event.code === "Space") editor.spacePressed = false; });
$("workspaceImage").onchange = async event => {
  const nextImage = event.target.value;
  if (!confirmImageChange()) {
    event.target.value = editor.image;
    return;
  }
  await loadEditorImage(nextImage);
};
window.addEventListener("beforeunload", event => {
  if (!editor.dirty && !(Segmentation.active() && Segmentation.dirty())) return;
  event.preventDefault();
  event.returnValue = "";
});
$("saveAnnotations").onclick = async () => {
  if (!current || !editor.image || editor.loading) return;
  if (Segmentation.active() && !Segmentation.canSave()) return;
  const projectId = current.id, image = editor.image;
  const submitted = JSON.stringify(editor.objects), segmentation = Segmentation.active();
  const status = $("workspaceStatus"), button = $("saveAnnotations");
  button.disabled = true;
  status.textContent = "正在保存…";
  try {
    const result = await api(`/api/projects/${projectId}/annotations`, {method: "PUT", body: JSON.stringify({image, objects: JSON.parse(submitted)})});
    if (current?.id !== projectId || editor.image !== image) return;
    const changed = JSON.stringify(editor.objects) !== submitted;
    if (!changed) { editor.objects = result.objects; editor.dirty = false; }
    editor.annotationStatus = result.status;
    current.labels_locked = true;
    current.status = result.status;
    renderCurrentLabels();
    status.textContent = changed
      ? "提交时的版本已保存；当前还有新的未保存修改。"
      : `已保存 ${result.objects.length} ${segmentation ? "个实例" : "个框"} · ${result.revision_id}`;
    Segmentation.sync();
    drawDetail();
  } catch (error) {
    if (current?.id === projectId && editor.image === image) status.textContent = `保存失败：${error.message}`;
  } finally { button.disabled = false; }
};

function adapterPayload() {
  const data = Object.fromEntries(new FormData($("adapterForm")));
  if (!data.api_key_env) data.api_key_env = null;
  return data;
}

function openAdapterDialog() {
  if (!current) return;
  const form = $("adapterForm");
  const adapter = current.ai_adapter || {};
  form.elements.kind.value = adapter.kind || "openai_compatible";
  form.elements.base_url.value = adapter.base_url || "";
  form.elements.model.value = adapter.model || "";
  form.elements.api_key_env.value = adapter.api_key_env || "";
  $("adapterStatus").className = "adapter-status";
  $("adapterStatus").textContent = adapter.model ? `当前已配置：${adapter.model}` : "尚未测试连接。";
  $("adapterDialog").showModal();
}

$("testAdapter").onclick = async () => {
  const status = $("adapterStatus");
  status.className = "adapter-status";
  status.textContent = "正在连接模型服务…";
  try {
    const result = await api(`/api/projects/${current.id}/adapter/test`, {method: "POST", body: JSON.stringify(adapterPayload())});
    status.className = `adapter-status ${result.ok ? "success" : "error"}`;
    status.textContent = result.message;
    $("modelOptions").innerHTML = result.models.map(model => `<option value="${escapeHtml(model)}"></option>`).join("");
    if (result.ok && result.models.length && !$("adapterForm").elements.model.value) {
      $("adapterForm").elements.model.value = result.models[0];
    }
  } catch (error) {
    status.className = "adapter-status error";
    status.textContent = error.message;
  }
};

$("adapterForm").addEventListener("submit", async event => {
  event.preventDefault();
  const status = $("adapterStatus");
  try {
    current = await api(`/api/projects/${current.id}/adapter`, {method: "PUT", body: JSON.stringify(adapterPayload())});
    projects = projects.map(project => project.id === current.id ? current : project);
    renderAnalysis();
    $("adapterDialog").close();
  } catch (error) {
    status.className = "adapter-status error";
    status.textContent = error.message;
  }
});

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
}

function renderImportFormats() {
  const select = $("datasetFormat"), previous = select.value;
  const task = $("projectForm").elements.task.value;
  select.innerHTML = datasetFormats.filter(f => f.can_import && f.tasks.includes(task))
    .map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.title)}</option>`).join("");
  if ([...select.options].some(o => o.value === previous)) select.value = previous;
  updateImportFields();
}

function updateImportFields() {
  const format = $("datasetFormat").value, annotated = format !== "images";
  const spec = datasetFormats.find(f => f.id === format)?.input || {};
  $("annotationSourceField").hidden = !annotated;
  $("annotationSource").required = !!spec.required;
  $("annotationSource").disabled = !annotated;
  $("labelsField").hidden = annotated || !labeledTasks.has($("projectForm").elements.task.value);
  $("annotationSource").placeholder = spec.placeholder || "可选的标注输入";
  $("importSplit").disabled = !!spec.split_from_source;
  $("datasetRootHint").textContent = spec.hint || "";
}

$("datasetFormat").onchange = updateImportFields;

function renderDatasetIO() {
  if (!current) return;
  const formats = datasetFormats.filter(f => f.can_export && f.tasks.includes(current.task));
  const previous = $("exportFormat").value;
  $("exportFormat").innerHTML = formats.map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.title)}</option>`).join("");
  if (formats.some(f => f.id === previous)) $("exportFormat").value = previous;
  $("exportDataset").disabled = !formats.length || !current.analysis;
  const summary = current.import_summary;
  const sourceTitle = current.dataset_format === "mixed" ? "多来源数据集" : datasetFormats.find(f => f.id === current.dataset_format)?.title || current.dataset_format;
  $("datasetIOSummary").textContent = summary
    ? `${sourceTitle} · ${summary.image_count} 张图像 · ${summary.object_count} ${current.task === "instance_segmentation" ? "个导入实例" : "个导入框"} · ${summary.issue_count} 项提示`
    : "重新分析数据后可使用 Dataset I/O。";
  if (!formats.length) $("datasetIOSummary").textContent += " 当前任务的格式适配器尚未开放。";
  $("showImportReport").disabled = !current.dataset_revision;
  $("appendDataset").disabled = !current.dataset_revision;
  $("showDatasetHistory").disabled = !current.dataset_revision;
  if (typeof renderExportCenter === "function") renderExportCenter();
}

$("showImportReport").onclick = async () => {
  const target = $("importReport");
  if (!target.hidden) { target.hidden = true; return; }
  target.hidden = false;
  target.textContent = "加载导入报告…";
  const projectId = current.id;
  try {
    const report = await api(`/api/projects/${projectId}/dataset/report`);
    if (current?.id === projectId) target.textContent = JSON.stringify(report, null, 2);
  } catch (error) { target.textContent = error.message; }
};

$("datasetExportForm").addEventListener("submit", async event => {
  event.preventDefault();
  await previewExportCenter();
});

Segmentation.init();
initImageBrowsers();
renderCreateLabels();
api("/api/dataset-formats").then(formats => {
  datasetFormats = formats;
  renderImportFormats();
  if (current) renderDatasetIO();
}).catch(error => { $("formError").textContent = `格式列表加载失败：${error.message}`; });
loadProjects().then(async () => {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get("project");
  if (!projectId) return;
  await showProject(projectId);
  if (current?.id !== projectId || current.task === "video") return;
  if (!current.analysis && current.video_source) await analyze(projectId);
  if (!current.analysis) return;
  await openAnnotationWorkspace();
  const path = params.get("image");
  if (path && path !== editor.image) {
    $("workspaceImageQuery").value = path;
    await loadImagePage("workspace", 0, path);
    const meta = editor.images.find(row => row.path === path);
    if (meta && editor.image !== path) {
      await loadEditorImage(path, meta);
      $("workspaceImage").value = path;
    }
  }
}).catch(error => { $("formError").textContent = `服务连接失败：${error.message}`; });

async function renderVideoFrameOrigin(projectId, path) {
  const target = $("videoFrameOrigin");
  target.hidden = true;
  target.replaceChildren();
  if (!current?.video_source) return;
  try {
    const {video} = await api(`/api/projects/${projectId}/image-origin?image=${encodeURIComponent(path)}`);
    if (current?.id !== projectId || editor.image !== path || !video) return;
    const link = document.createElement("a");
    link.href = `/video?${new URLSearchParams({project: video.project_id, video: video.video_id, frame: video.frame_index})}`;
    link.textContent = `返回来源视频 · 第 ${video.frame_index + 1} 帧 · ${Number(video.timestamp).toFixed(3)} 秒`;
    target.appendChild(link);
    target.hidden = false;
  } catch { /* An independently exported image may no longer have a source video. */ }
}
