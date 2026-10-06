#!/usr/bin/env node
/**
 * SHOTGUARD 自动验收工具 v1.0
 *
 * 输入：一段 AI 视频 + 角色/场景设定 + 角色参考图
 * 输出：逐镜崩坏检测报告（8 类崩坏）
 *
 * API 配置：填入你的视觉模型 API 信息即可使用
 * 支持：OpenAI 兼容 API（GPT-4V / Claude / Qwen-VL / Gemini / 豆包视觉 / 其他视觉理解模型）
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ═══════════════════════════════════════════════════════════════
// API 配置区：填入你的视觉模型 API 信息
// ═══════════════════════════════════════════════════════════════
const API_CONFIG = {
  // 方式 1：OpenAI 兼容 API（GPT-4V / Qwen-VL / 豆包视觉 / 其他兼容 OpenAI 格式的视觉模型）
  baseURL: process.env.VISION_API_BASE_URL || 'https://api.openai.com/v1',  // 改成你的 API 地址
  apiKey: process.env.VISION_API_KEY || '',                                  // 改成你的 API Key
  model: process.env.VISION_MODEL || 'gpt-4o',                               // 改成你的模型名

  // 方式 2：自定义请求格式（如果上面的 OpenAI 兼容格式不适用，改这里）
  customFormat: false,  // 设为 true 使用自定义格式
};

const DIR = __dirname;

// ═══════════════════════════════════════════════════════════════
// 抽帧：从视频中均匀抽取关键帧
// ═══════════════════════════════════════════════════════════════
function extractFrames(videoPath, outDir, count = 6) {
  fs.mkdirSync(outDir, { recursive: true });

  // 取视频时长
  let duration = 5;
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath], { encoding: 'utf8' });
    duration = parseFloat(out.trim()) || 5;
  } catch (e) { /* 用默认值 */ }

  const frames = [];
  for (let i = 0; i < count; i++) {
    const t = (duration / (count + 1)) * (i + 1);
    const outPath = path.join(outDir, `frame_${String(i).padStart(3, '0')}.png`);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(t), '-i', videoPath, '-frames:v', '1', '-q:v', '2', outPath], { stdio: 'pipe' });
    frames.push({ path: outPath, time: t.toFixed(2), index: i });
  }
  return frames;
}

// ═══════════════════════════════════════════════════════════════
// 视觉模型调用：给参考图 + 帧，让模型判断崩坏类型
// ═══════════════════════════════════════════════════════════════
async function callVisionAPI(referenceImagePath, frameImagePath, charDesc, sceneDesc, retryCount = 0) {
  const prompt = `请对比两张图片，检测 AI 视频崩坏。只返回 JSON，不要其他内容。

参考图角色设定：${charDesc}
参考图场景设定：${sceneDesc}

检测以下 8 类崩坏，逐一判断：
1. 身份漂移：人脸、发型、服装与参考图是否一致
2. 服装漂移：服装款式、颜色、穿着状态是否与参考图一致
3. 道具漂移：参考图中的道具是否凭空出现或消失
4. 空间漂移：场景结构（门窗位置、家具布局、左右关系）是否与参考图一致
5. 光线漂移：光源方向、阴影方向是否与参考图一致
6. 状态回滚：参考图中的状态（天气、时间、破损）是否被无理由改变
7. 动作断链：当前帧是否是空镜（完全没有人物）或与前后动作不连贯
8. 声音断链：不适用（跳过，返回 null）

返回格式（严格 JSON）：
{
  "identity_drift": true/false,
  "clothing_drift": true/false,
  "prop_drift": true/false,
  "spatial_drift": true/false,
  "lighting_drift": true/false,
  "state_rollback": true/false,
  "action_break": true/false,
  "issues": ["具体问题描述1", "具体问题描述2"]
}

如果某项无法从单帧判断（如声音），返回 null。`;

  const refImageBase64 = fs.readFileSync(referenceImagePath).toString('base64');
  const frameImageBase64 = fs.readFileSync(frameImagePath).toString('base64');

  const requestBody = {
    model: API_CONFIG.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${refImageBase64}` }
          },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${frameImageBase64}` }
          }
        ]
      }
    ],
    max_tokens: 1000,
    temperature: 0
  };

  const response = await fetch(`${API_CONFIG.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_CONFIG.apiKey}`
    },
    body: JSON.stringify(requestBody)
  });

  // 限流处理：429 时等待后重试
  if (response.status === 429) {
    if (retryCount < 3) {
      const waitMs = 2000 * Math.pow(2, retryCount);
      console.log(`(限流 429，等待 ${waitMs/1000}s 后重试 ${retryCount + 1}/3)`);
      await new Promise(r => setTimeout(r, waitMs));
      return callVisionAPI(referenceImagePath, frameImagePath, charDesc, sceneDesc, retryCount + 1);
    } else {
      throw new Error('API 限流，已重试 3 次仍失败');
    }
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 请求失败 ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';

  // 提取 JSON（模型可能返回带 markdown 代码块的 JSON，或前后有解释文字）
  let jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    // 尝试匹配 markdown 代码块
    jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonMatch = jsonMatch[1].match(/\{[\s\S]*\}/);
    }
  }
  if (!jsonMatch) {
    // 如果模型返回空内容或拒绝，返回一个"无法判断"的结果而不是抛错
    console.log('(模型未返回有效内容，标记为无法判断)');
    return {
      identity_drift: null,
      clothing_drift: null,
      prop_drift: null,
      spatial_drift: null,
      lighting_drift: null,
      state_rollback: null,
      action_break: null,
      issues: ['模型未返回有效内容，无法判断'],
      uncertain: true
    };
  }

  return JSON.parse(jsonMatch[0]);
}

// ═══════════════════════════════════════════════════════════════
// 主流程：抽帧 → 逐帧检测 → 汇总报告
// ═══════════════════════════════════════════════════════════════
async function verifyVideo(videoPath, refImagePath, charDesc, sceneDesc, frameCount = 6) {
  console.log('=== SHOTGUARD 自动验收 ===\n');
  console.log('视频:', path.basename(videoPath));
  console.log('参考图:', path.basename(refImagePath));
  console.log('角色:', charDesc.slice(0, 50) + '...');
  console.log('场景:', sceneDesc.slice(0, 50) + '...\n');

  // 1. 抽帧
  console.log('--- 抽帧 ---');
  const frames = extractFrames(videoPath, path.join(DIR, '_frames'), frameCount);
  console.log(`已抽取 ${frames.length} 帧\n`);

  // 2. 逐帧检测
  console.log('--- 逐帧检测 ---\n');
  const results = [];

  for (const frame of frames) {
    process.stdout.write(`  帧 ${frame.index + 1}/${frames.length} (${frame.time}s) ... `);
    try {
      const result = await callVisionAPI(refImagePath, frame.path, charDesc, sceneDesc);
      const issues = [];
      if (result.identity_drift) issues.push('身份漂移');
      if (result.clothing_drift) issues.push('服装漂移');
      if (result.prop_drift) issues.push('道具漂移');
      if (result.spatial_drift) issues.push('空间漂移');
      if (result.lighting_drift) issues.push('光线漂移');
      if (result.state_rollback) issues.push('状态回滚');
      if (result.action_break) issues.push('动作断链');

      const status = issues.length === 0 ? '✓ 通过' : `✗ ${issues.join('、')}`;
      console.log(status);

      results.push({
        frame: frame.path,
        time: frame.time,
        index: frame.index,
        ...result,
        detectedIssues: issues
      });

      // 请求间隔：避免触发限流（每张图约 2000 tokens，间隔 1.5s）
      if (frame.index < frames.length - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (e) {
      console.log('检测失败:', e.message.slice(0, 60));
      results.push({
        frame: frame.path,
        time: frame.time,
        index: frame.index,
        error: e.message
      });
    }
  }

  // 3. 汇总报告
  console.log('\n--- 验收报告 ---\n');
  const validResults = results.filter(r => !r.error && !r.uncertain);
  const uncertainResults = results.filter(r => r.uncertain);
  const failCounts = {
    identity_drift: validResults.filter(r => r.identity_drift).length,
    clothing_drift: validResults.filter(r => r.clothing_drift).length,
    prop_drift: validResults.filter(r => r.prop_drift).length,
    spatial_drift: validResults.filter(r => r.spatial_drift).length,
    lighting_drift: validResults.filter(r => r.lighting_drift).length,
    state_rollback: validResults.filter(r => r.state_rollback).length,
    action_break: validResults.filter(r => r.action_break).length
  };

  const totalIssues = Object.values(failCounts).reduce((a, b) => a + b, 0);
  const pass = totalIssues === 0 && validResults.length > 0;
  const confidence = validResults.length / results.length;

  console.log(`总帧数：${results.length}`);
  console.log(`成功检测：${validResults.length}`);
  console.log(`无法判断：${uncertainResults.length}`);
  console.log(`失败帧数：${results.length - validResults.length - uncertainResults.length}\n`);

  if (totalIssues > 0) {
    console.log('崩坏统计：');
    if (failCounts.identity_drift) console.log(`  身份漂移：${failCounts.identity_drift} 帧`);
    if (failCounts.clothing_drift) console.log(`  服装漂移：${failCounts.clothing_drift} 帧`);
    if (failCounts.prop_drift) console.log(`  道具漂移：${failCounts.prop_drift} 帧`);
    if (failCounts.spatial_drift) console.log(`  空间漂移：${failCounts.spatial_drift} 帧`);
    if (failCounts.lighting_drift) console.log(`  光线漂移：${failCounts.lighting_drift} 帧`);
    if (failCounts.state_rollback) console.log(`  状态回滚：${failCounts.state_rollback} 帧`);
    if (failCounts.action_break) console.log(`  动作断链：${failCounts.action_break} 帧`);
  }

  console.log(`\n检测置信度：${(confidence * 100).toFixed(0)}%（${validResults.length}/${results.length} 帧成功）`);
  console.log(pass ? '✅ 验收通过' : '⚠️ 验收未通过');

  // 保存详细报告
  const report = {
    video: path.basename(videoPath),
    reference: path.basename(refImagePath),
    character: charDesc,
    scene: sceneDesc,
    frameCount: results.length,
    validCount: validResults.length,
    failCounts,
    pass,
    frames: results,
    timestamp: new Date().toISOString()
  };

  const reportPath = path.join(DIR, 'verify_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n详细报告已保存: ${reportPath}`);

  // 生成 HTML 交付报告（带帧截图，可直接给甲方）
  const htmlPath = generateHTMLReport(report, refImagePath);
  console.log(`HTML 交付报告已保存: ${htmlPath}`);

  return report;
}

// ═══════════════════════════════════════════════════════════════
// HTML 报告生成器：把 JSON 数据变成带帧截图的精美交付物
// ═══════════════════════════════════════════════════════════════
function generateHTMLReport(report, refImagePath) {
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 把帧图片转成 base64 内嵌（单文件交付）
  const frameImages = report.frames.map(f => {
    try {
      return fs.readFileSync(f.frame).toString('base64');
    } catch (e) {
      return null;
    }
  });

  const refImageBase64 = fs.existsSync(refImagePath)
    ? fs.readFileSync(refImagePath).toString('base64')
    : null;

  const issueNames = {
    identity_drift: '身份漂移',
    clothing_drift: '服装漂移',
    prop_drift: '道具漂移',
    spatial_drift: '空间漂移',
    lighting_drift: '光线漂移',
    state_rollback: '状态回滚',
    action_break: '动作断链'
  };

  const totalIssues = Object.values(report.failCounts).reduce((a, b) => a + b, 0);
  const confidence = Math.round(report.validCount / report.frameCount * 100);

  let framesHTML = '';
  report.frames.forEach((f, i) => {
    const img = frameImages[i];
    const statusClass = f.error ? 'fail' : (f.uncertain ? 'uncertain' : (f.detectedIssues && f.detectedIssues.length > 0 ? 'fail' : 'ok'));
    const statusText = f.error ? '检测失败' : (f.uncertain ? '无法判断' : (f.detectedIssues && f.detectedIssues.length > 0 ? '✗ ' + f.detectedIssues.join('、') : '✓ 通过'));

    framesHTML += `
    <div class="frame ${statusClass}">
      ${img ? `<img src="data:image/png;base64,${img}" alt="帧 ${f.index + 1}">` : '<div class="noimg">帧图片不可用</div>'}
      <div class="frame-info">
        <div class="frame-time">帧 ${f.index + 1} · ${f.time}s</div>
        <div class="frame-status">${esc(statusText)}</div>
        ${f.issues && f.issues.length ? `<div class="frame-issues">${f.issues.map(esc).join('<br>')}</div>` : ''}
      </div>
    </div>`;
  });

  let statsHTML = '';
  for (const [key, name] of Object.entries(issueNames)) {
    const count = report.failCounts[key] || 0;
    if (count > 0) {
      statsHTML += `<div class="stat-item fail"><div class="stat-num">${count}</div><div class="stat-label">${name}</div></div>`;
    }
  }
  if (totalIssues === 0) {
    statsHTML = '<div class="stat-item ok"><div class="stat-num">0</div><div class="stat-label">崩坏帧</div></div>';
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>验收报告 · ${esc(report.video)}</title>
<style>
:root{--bg:#0b0d10;--panel:#14171c;--panel2:#1b1f26;--line:#2a303a;--txt:#e8ecf2;--dim:#8b95a5;--ok:#4ade80;--a2:#22d3ee;--warn:#fbbf24;--err:#f87171}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--txt);font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;line-height:1.7;padding:32px 20px}
.wrap{max-width:1000px;margin:0 auto}
h1{font-size:26px;margin-bottom:6px}
h1 span{color:var(--ok)}
.meta{color:var(--dim);font-size:13px;margin-bottom:24px}
.status{font-size:20px;font-weight:700;text-align:center;padding:18px;border-radius:10px;margin:20px 0}
.status.pass{background:rgba(74,222,128,.12);color:var(--ok);border:1px solid rgba(74,222,128,.3)}
.status.fail{background:rgba(248,113,113,.12);color:var(--err);border:1px solid rgba(248,113,113,.3)}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:20px 0}
.summary-item{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;text-align:center}
.summary-item .num{font-size:30px;font-weight:700;color:var(--ok)}
.summary-item .label{font-size:12px;color:var(--dim);margin-top:4px}
h2{font-size:17px;margin:26px 0 14px;color:var(--a2);border-bottom:1px solid var(--line);padding-bottom:8px}
.ref{display:flex;gap:16px;align-items:flex-start;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}
.ref img{width:200px;border-radius:8px;border:1px solid var(--line)}
.ref-info{flex:1;font-size:13px;color:var(--dim)}
.ref-info b{color:var(--txt);display:block;margin-bottom:6px;font-size:14px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:16px 0}
.stat-item{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;text-align:center}
.stat-item.fail .stat-num{color:var(--err)}
.stat-item.ok .stat-num{color:var(--ok)}
.stat-num{font-size:26px;font-weight:700}
.stat-label{font-size:12px;color:var(--dim);margin-top:4px}
.frames{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin:16px 0}
.frame{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.frame img{width:100%;display:block}
.frame.ok{border-left:4px solid var(--ok)}
.frame.fail{border-left:4px solid var(--err)}
.frame.uncertain{border-left:4px solid var(--warn)}
.frame-info{padding:12px}
.frame-time{font-size:12px;color:var(--dim);margin-bottom:4px}
.frame-status{font-size:14px;font-weight:600;margin-bottom:6px}
.frame.ok .frame-status{color:var(--ok)}
.frame.fail .frame-status{color:var(--err)}
.frame.uncertain .frame-status{color:var(--warn)}
.frame-issues{font-size:12px;color:var(--err);line-height:1.6}
.noimg{padding:40px;text-align:center;color:var(--dim);font-size:13px}
footer{color:var(--dim);font-size:12px;text-align:center;padding:24px 0;border-top:1px solid var(--line);margin-top:24px}
</style>
</head>
<body>
<div class="wrap">
<h1>验收报告 <span>·</span> ${esc(report.video)}</h1>
<div class="meta">生成时间：${new Date(report.timestamp).toLocaleString('zh-CN')} · 检测工具：SHOTGUARD 自动验收</div>

<div class="status ${report.pass ? 'pass' : 'fail'}">
${report.pass ? '✅ 验收通过' : '⚠️ 验收未通过'}
</div>

<div class="summary">
  <div class="summary-item"><div class="num">${confidence}%</div><div class="label">检测置信度</div></div>
  <div class="summary-item"><div class="num">${report.frameCount}</div><div class="label">总帧数</div></div>
  <div class="summary-item"><div class="num">${report.validCount}</div><div class="label">成功检测</div></div>
  <div class="summary-item"><div class="num">${totalIssues}</div><div class="label">崩坏帧</div></div>
</div>

<h2>参考图与设定</h2>
<div class="ref">
  ${refImageBase64 ? `<img src="data:image/png;base64,${refImageBase64}" alt="参考图">` : '<div class="noimg">参考图不可用</div>'}
  <div class="ref-info">
    <b>角色设定</b>
    ${esc(report.character)}
    <b style="margin-top:12px">场景设定</b>
    ${esc(report.scene)}
  </div>
</div>

<h2>崩坏统计</h2>
<div class="stats">
  ${statsHTML}
</div>

<h2>逐帧检测</h2>
<div class="frames">
  ${framesHTML}
</div>

<footer>SHOTGUARD · AI 视频自动验收 · 本报告由工具自动生成，检测置信度 ${confidence}%</footer>
</div>
</body>
</html>`;

  const htmlPath = path.join(DIR, 'verify_report.html');
  fs.writeFileSync(htmlPath, html, 'utf8');
  return htmlPath;
}

// ═══════════════════════════════════════════════════════════════
// CLI 入口
// ═══════════════════════════════════════════════════════════════
async function main() {
  const videoPath = process.argv[2];
  const refImagePath = process.argv[3];
  const charDesc = process.argv[4] || '17岁少女，黑色长直发及肩，右侧银色发夹，米色针织开衫内搭白衬衫';
  const sceneDesc = process.argv[5] || '木质地板，白色墙面，右侧一扇落地窗，窗下有灰色布艺沙发';

  if (!videoPath || !refImagePath) {
    console.error('用法: node src/shotguard-verify.js <视频文件> <角色参考图> [角色描述] [场景描述]');
    console.error('');
    console.error('环境变量配置：');
    console.error('  VISION_API_BASE_URL - 视觉模型 API 地址（默认 https://api.openai.com/v1）');
    console.error('  VISION_API_KEY - API Key（必填）');
    console.error('  VISION_MODEL - 模型名（默认 gpt-4o）');
    process.exit(1);
  }

  if (!API_CONFIG.apiKey) {
    console.error('错误：未设置 VISION_API_KEY 环境变量');
    console.error('请先设置：export VISION_API_KEY=你的API密钥');
    process.exit(1);
  }

  try {
    await verifyVideo(videoPath, refImagePath, charDesc, sceneDesc);
  } catch (e) {
    console.error('验收失败:', e.message);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { extractFrames, callVisionAPI, verifyVideo };
