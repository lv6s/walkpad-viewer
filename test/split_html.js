/*
 * 把单文件 wt901ble_live.html 拆成 index 结构：
 *   css/style.css            样式
 *   js/core.js               元素寻址 / 日志 / 下载 / 通用格式化
 *   js/chart.js              设备折线图、对比图、gizmo、demo 数据
 *   js/camera.js             摄像头取流、录像、探针
 *   js/wt901.js              维特 WT901 多设备：协议、连接、MAC、文本导出
 *   js/insole-proto.js       自研鞋垫：协议解帧、命令、校准、零偏
 *   js/insole-ui.js          鞋垫界面：双面板、压力图、波形、数值
 *   js/insole-export.js      帧导出为 parquet
 *   js/main.js               入口绑定、主循环、调试出口
 *
 * 切分单位是 AST 顶层节点，节点前导注释随节点走，因此不丢语句、不丢注释。
 * 非声明节点（顶层赋值 / 立即执行语句）按行号归属。
 */
const fs = require('fs');
const path = require('path');
const acorn = require('C:/Users/35317/AppData/Local/Temp/pqbuild/node_modules/acorn');

const SRC = 'C:/Users/35317/Desktop/walkpad/imu_tools/wt901ble_live.html';
const OUT = 'C:/Users/35317/Desktop/walkpad/imu_tools';
const html = fs.readFileSync(SRC, 'utf8');

/* ---------------- 切出三段：head 头、style、body、script ---------------- */
const styleOpen = html.indexOf('<style>');
const styleClose = html.indexOf('</style>');
const css = html.slice(styleOpen + 7, styleClose);

const bodyOpen = html.indexOf('<body>');
const tail = html.lastIndexOf('<script>');
const bodyHtml = html.slice(bodyOpen + 6, html.lastIndexOf('<script src="parquet_writer.js">')).trimEnd();

const scriptStart = tail + 8;
const scriptEnd = html.indexOf('</script>', tail);
const code = html.slice(scriptStart, scriptEnd);
const scriptFirstLine = html.slice(0, scriptStart).split('\n').length;

/* ---------------- AST 顶层节点 ---------------- */
const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script' });
const lineOf = (pos) => code.slice(0, pos).split('\n').length + scriptFirstLine - 1;

/* node -> key（声明名）；非声明返回 null，改用行号 */
function declNames(node) {
  if (node.type === 'FunctionDeclaration' && node.id) return [node.id.name];
  if (node.type === 'VariableDeclaration') {
    return node.declarations.map((d) => (d.id.type === 'Identifier' ? d.id.name : null)).filter(Boolean);
  }
  return null;
}

/* ---------------- 分组表 ---------------- */
const FILES = ['core', 'chart', 'camera', 'wt901', 'insole-proto', 'insole-ui', 'insole-export', 'main'];
const BY_NAME = {};
const put = (file, names) => {
  for (const n of names.split(/\s+/).filter(Boolean)) {
    if (BY_NAME[n]) throw new Error('重复映射 ' + n + '：' + BY_NAME[n] + ' / ' + file);
    BY_NAME[n] = file;
  }
};

put('core', `IR_ELS irCur $ CLOCK state log pad isoLocal num stampName
  loadLabels saveLabels rememberLabel download hex2 hexOf`);

put('chart', `AXIS_COLORS GREY DEV_COLORS segPick setMode renderLegend fit sliceFrom
  CUBE EDGES rot project drawGizmo niceUp drawDeviceChart cmpValue drawCompare
  fmt updateReadout startDemo feedDemo`);

put('camera', `CAM_PROBE_RES CAM_PROBE_FPS markResOptions camList camCapsAll camCapsKey
  camCapsGet camCapsSet syncFpsOptions camFrameCheck camTick camMeter camDrawRot
  camLoopOn camLoopOff camSetRot cam camCfgTimer camCfgChanged camPermNote camOpen
  camOpenStream camClose camStartRec camStopRec camShot camProbe`);

put('wt901', `SERVICE CHAR_NOTIFY CHAR_WRITE REG_MAC REG_BATT REG_VER
  ACC_S GYR_S ANG_S MAG_S Q_S FRAME_LEN KEEP_SEC PANELS
  LBL_KEY DEVTOK OFFICIAL_HEADER makeDevice buildCard updateHead syncGrid
  s16 parse onPacket officialLine push bindDisc connectOne onDisc autoReconnect
  toggleRec stopRec requestWake macOf MAC_ORDERS MAC_ORDER_KEY macOrder nextMacOrder
  setMac applySavedLabel setMacManual battPct regReply readReg readGapName probeInfo
  exportNames labelKey syncNames buildTxt onlineCount updateBtns clearData`);

put('insole-proto', `U16 IR_ACC_G IR_GYR_DPS IR_KEEP IR_COLORS PR_W PR_H PR_N
  PR_ROWS IR_POS PR_IDLE PR_MAX PR_SPAN_G PR_SPAN_RAW FMT_NAME FMT_UNIT
  irLinkMode PR_EDGE IR_RAW_V2 IR_RAW_V1 irNewState IR_SIDES irStates
  irActive ir irOf irLut irLutOf irBuildLut footFromName irOnOf irAnyOn irOn
  setCur withFoot isImurDev irConnect irReadInfo irGone irClose irEvt irEvtW
  IR_LINK_NAME irCrcIbm irCrcAck irCmd irDropWait irWrite irRxHint irSend irProbe
  irAck irState irCalibBrief irStateText irQueryState FMT_SELF irSetFmt
  IR_ACK_TYPES IR_LOOSE_SIZE irSniff irCrcOk irFeed irFrame irTick
  IR_BIAS_WIN IR_BIAS_GSTD IR_BIAS_ASTD IR_BIAS_AERR IR_BIAS_ALPHA IR_BIAS_STEP
  IR_BIAS_MAX irBiasTrack irBiasReset irBiasText`);

put('insole-ui', `irHead irState0 irNums irDraw PW_WIN PW_KEEP prFmt prU prBase prSpan
  prColorSpan prCap fmtV FMT_KEY irFmtLoad irFmtSave irFmtText irRedraw
  pwPush pwPick pwName pwTop pwDraw PR_STOPS prColor prLabel prCur prOutline
  prRKey prRVal prRadius irPressDraw prNums prReset pwCsv irHitAt irBindPanel irRenderPanels`);

put('insole-export', `FR_MEASUREMENT_CONTRACT REC_T0 FR_DATASET_ID FR_SESSION_ID
  irFramesRows FR_LISTS FR_INT64 frUid irParquetColumns irParquetBuffer irParquet`);

put('main', `lastStat lastDraw loop`);

/* 非声明节点：按所在行归属。
 * 顶层"会执行"的语句一律放进 main.js —— 它们要引用别的文件的函数，
 * 而跨 <script> 没有 hoisting，放在定义它的文件里会在加载时 ReferenceError。 */
const BY_LINE = {
  403: 'core',                     // window error 监听（只依赖同文件的 log）
  566: 'wt901',                    // devGrid 卡片点击
  961: 'wt901', 989: 'wt901', 1020: 'wt901', 1022: 'wt901',
  1099: 'wt901',                   // btnRec
  1112: 'wt901',                   // visibilitychange
  1326: 'wt901', 1333: 'wt901',    // btnTxt / btnCsv
  1826: 'camera', 1827: 'camera', 1828: 'camera', 1829: 'camera',
  1830: 'camera', 1831: 'camera', 1832: 'camera', 1833: 'camera', 1834: 'camera',
  2797: 'main',                    // btnIrOn（引用 insole-proto 的 irConnect）
  3247: 'main', 3248: 'main', 3256: 'main', 3261: 'main', 3272: 'main',   // 面板渲染与初始化
  3299: 'chart', 3300: 'chart', 3301: 'chart', 3302: 'chart',
  3628: 'main', 3629: 'main',      // lastStat/lastDraw 变量与主循环
  3690: 'main', 3693: 'main', 3766: 'main',
};

/* ---------------- 切块 ---------------- */
const nodes = [];
for (const node of ast.body) nodes.push({ node, s: lineOf(node.start), e: lineOf(node.end) });

const buckets = Object.fromEntries(FILES.map((f) => [f, []]));
const problems = [];
let prevEndPos = 0;

nodes.forEach((item, idx) => {
  const { node } = item;
  const names = declNames(node);
  let target = null;

  if (names && names.length) {
    const set = new Set(names.map((n) => BY_NAME[n] || null));
    if (set.size !== 1 || set.has(null)) {
      problems.push('未映射或跨文件: ' + item.s + ' ' + names.join(','));
    } else target = [...set][0];
  } else {
    target = BY_LINE[item.s];
    if (!target) problems.push('未映射语句: ' + item.s + ' ' + code.slice(node.start, node.start + 50).replace(/\n/g, ' '));
  }
  if (!target) return;

  /* 块 = 从上一节点结束到本节点结束，前导注释与空行随本节点走 */
  const chunk = code.slice(prevEndPos, node.end).replace(/^\n+/, '');
  buckets[target].push({ s: item.s, e: item.e, text: chunk });
  prevEndPos = node.end;
});

if (problems.length) {
  console.error('有 ' + problems.length + ' 个节点没能归属：');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}

/* 末尾残余（最后一个节点之后的所有内容）归 main */
const tailChunk = code.slice(prevEndPos);
if (tailChunk.trim()) buckets.main.push({ s: 0, e: 0, text: tailChunk });

/* ---------------- 输出 ---------------- */
const HEADER = {
  core: '全局基础设施：元素寻址、日志、格式化、下载、名称记忆。',
  chart: '设备侧图表：折线图、指标对比、姿态 cubes、演示数据。',
  camera: '摄像头：取流、画中画、录像、能力探针。',
  wt901: '维特 WT901 多设备：广播协议、连接、MAC 识别、文本导出。',
  'insole-proto': '自研鞋垫协议层：状态、解帧、命令与应答、IMU 校准、零偏估计。',
  'insole-ui': '自研鞋垫界面层：双面板渲染、压力图、点位波形、数值与格式。',
  'insole-export': '帧导出：把两脚录到的帧写成与 app 同构的 parquet。',
  main: '入口：事件绑定、主循环、启动引导、调试出口。',
};

fs.mkdirSync(path.join(OUT, 'js'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'css'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'css/style.css'), css.trim() + '\n');

const stats = [];
for (const f of FILES) {
  const parts = buckets[f];
  if (!parts.length) throw new Error(f + ' 是空的');
  const body = parts.map((p) => p.text.replace(/\s+$/, '')).join('\n\n');
  const out = '/* ' + HEADER[f] + ' */\n\n' + body + '\n';
  fs.writeFileSync(path.join(OUT, 'js/' + f + '.js'), out);
  stats.push([f, parts.length, out.split('\n').length]);
}

/* HTML 只留结构与 script 顺序 */
const head = html.slice(0, styleOpen).trimEnd();
const newHtml = `${head}
<link rel="stylesheet" href="css/style.css">
</head>
<body>
${bodyHtml}

<script src="parquet_writer.js"></script>
${FILES.map((f) => `<!-- ${HEADER[f]} -->\n<script src="js/${f}.js"></script>`).join('\n')}
</body>
</html>
`;
fs.writeFileSync(path.join(OUT, 'wt901ble_live.html'), newHtml);

console.log('分组结果：');
for (const [f, n, l] of stats) console.log('  ' + (f + '.js').padEnd(22) + String(n).padStart(4) + ' 块  ' + String(l).padStart(5) + ' 行');
console.log('  style.css'.padEnd(24) + String(css.split('\n').length).padStart(5) + ' 行');
console.log('  HTML 结构 ' + newHtml.split('\n').length + ' 行');
