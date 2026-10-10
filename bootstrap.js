/*
 * bootstrap.js —— 启动引导层（内容更新机制的入口）
 *
 * 为什么要它：
 *   网游的做法是「引擎只装一次，之后只更新脚本和资源」。Electron 应用默认把代码打进安装包，
 *   每次改一行代码都要重下 190MB。这里把「引擎」（Electron 运行时 + 本引导层）和「内容」
 *   （dist + dist-electron：界面、卡牌数据、卡图）拆开：
 *
 *     - 安装包只负责装引擎，并在 <安装目录>/resources/app/baseline 放一份完整内容（离线可玩）。
 *     - 内容目录放在可写位置，更新时只下载「哈希变了的文件」（通常几百 KB）。
 *     - 本引导层负责：选内容目录 → 应用已下载好的更新 → 启动失败自动回退 → 再 require 真正的 main.js。
 *
 * 目录结构（安装版）：
 *   %APPDATA%\lycee-overture-battle\app\
 *     current\        正在运行的内容（dist / dist-electron / state.json）
 *     staged\         已下载并通过 sha256 校验、等待下次启动生效的内容
 *     prev\           上一个版本里被覆盖/删除的文件（回退用）+ state.json
 *     state.json      版本号、启动尝试次数、待生效版本
 *
 * 便携版/解压版：内容就在程序目录本身（<exeDir>/dist 与 <exeDir>/dist-electron），
 * 便携版每次从临时目录解压，改不了，所以不参与增量更新。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const app = process.env.ELECTRON_RUN_AS_NODE ? null : require('electron').app;

/** 是否打包后的运行形态 */
function isPackaged() {
  try {
    return !!(app && app.isPackaged);
  } catch {
    return false;
  }
}

/** 便携版：electron-builder 会设置 PORTABLE_EXECUTABLE_DIR，此时 execPath 是临时解压目录 */
function portableDir() {
  return process.env.PORTABLE_EXECUTABLE_DIR || '';
}

function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 一个内容目录必须同时有 dist-electron/main.js 与 dist/index.html 才算可用 */
function isContentDir(p) {
  return fileExists(path.join(p, 'dist-electron', 'main.js')) && fileExists(path.join(p, 'dist', 'index.html'));
}

/** 读取内容目录里的 state.json（记录版本号与文件哈希） */
function readState(p) {
  try {
    return JSON.parse(fs.readFileSync(path.join(p, 'state.json'), 'utf-8'));
  } catch {
    return null;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

/** 递归列出目录下所有文件（相对路径） */
function listFiles(root, sub) {
  const out = [];
  const base = sub ? path.join(root, sub) : root;
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = sub ? sub + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...listFiles(root, rel));
    else out.push(rel);
  }
  return out;
}

// ===== 1. 解析各路径 =====

const exeDir = path.dirname(process.execPath);
/** 引擎自带的内容（只读、离线兜底） */
const bundledContent = isPackaged() ? path.join(__dirname, 'baseline') : __dirname;
/** 用户目录下的可更新内容根 */
function userAppRoot() {
  try {
    const appData = app.getPath('appData');
    return path.join(appData, 'lycee-overture-battle', 'app');
  } catch {
    return path.join(exeDir, 'app');
  }
}

// 自动化测试用：LYCEE_TEST_ROOT 指向一个临时根目录（current/staged/state.json 都在里面），
// 这样可以在不改动真实安装目录的前提下跑完整的「下载 → 重启替换」流程。
const testRoot = process.env.LYCEE_TEST_ROOT || '';
const canUpdate = testRoot ? true : isPackaged() && !portableDir();
const appRoot = testRoot || (canUpdate ? userAppRoot() : path.join(exeDir, 'app'));
const statePath = path.join(appRoot, 'state.json');

function readAppState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeAppState(s) {
  try {
    writeJson(statePath, s);
  } catch (e) {
    console.warn('[boot] 写入 state.json 失败：', e && e.message);
  }
}

// ===== 2. 应用已下载好的更新（staged → current）=====

/** 把 staged 里的文件覆盖到 current，并把覆盖前的旧文件备份到 prev（可回退） */
function applyStaged(currentDir, stagedDir) {
  const next = readState(stagedDir);
  if (!next || !next.files) return false;
  const filesRoot = path.join(stagedDir, 'files');
  const files = listFiles(filesRoot); // 相对 files 目录的路径，例如 dist/index.html
  // 备份 + 覆盖
  const backup = [];
  for (const rel of files) {
    const dst = path.join(currentDir, rel);
    if (fileExists(dst)) {
      const bak = path.join(appRoot, 'prev', 'files', rel);
      try {
        copyFile(dst, bak);
        backup.push(rel);
      } catch (e) {
        console.warn('[boot] 备份旧文件失败：', rel, e && e.message);
      }
    }
    copyFile(path.join(filesRoot, rel), dst);
  }
  // 删除新版本里已经没有的文件（先备份）
  const cur = readState(currentDir);
  if (cur && cur.files) {
    for (const rel of Object.keys(cur.files)) {
      if (next.files[rel]) continue;
      const p = path.join(currentDir, rel);
      if (!fileExists(p)) continue;
      try {
        copyFile(p, path.join(appRoot, 'prev', 'files', rel));
        backup.push(rel);
        fs.unlinkSync(p);
      } catch (e) {
        console.warn('[boot] 删除旧文件失败：', rel, e && e.message);
      }
    }
  }
  writeJson(path.join(appRoot, 'prev', 'state.json'), cur || { version: '', files: {} });
  writeJson(path.join(currentDir, 'state.json'), next);
  try {
    fs.rmSync(stagedDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
  console.log('[boot] 已应用更新 → v' + next.version + '（变更 ' + files.length + ' 个文件）');
  return true;
}

/** 回退：把 prev 里备份的文件还原，并删掉 current */
function rollback(currentDir) {
  const prevFilesRoot = path.join(appRoot, 'prev', 'files');
  let restored = 0;
  if (dirExists(prevFilesRoot)) {
    for (const rel of listFiles(prevFilesRoot)) {
      try {
        copyFile(path.join(prevFilesRoot, rel), path.join(currentDir, rel));
        restored++;
      } catch (e) {
        console.warn('[boot] 回退失败：', rel, e && e.message);
      }
    }
  }
  const prevState = readState(path.join(appRoot, 'prev'));
  if (prevState && prevState.files) {
    try {
      writeJson(path.join(currentDir, 'state.json'), prevState);
    } catch {
      /* 忽略 */
    }
  }
  try {
    fs.rmSync(prevFilesRoot, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
  console.warn('[boot] 已回退到上一个版本（还原 ' + restored + ' 个文件）');
}

/** 启动失败（连续两次没成功启动）→ 回退；没有可回退内容则丢弃 current 用自带 baseline */
function maybeRollback(currentDir) {
  const st = readAppState();
  const attempts = Number(st.bootAttempts || 0);
  if (attempts < 2) return false;
  if (fileExists(path.join(appRoot, 'prev', 'state.json'))) {
    rollback(currentDir);
  } else {
    try {
      fs.rmSync(currentDir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    console.warn('[boot] 连续启动失败且无可回退内容，改用安装包自带内容');
  }
  writeAppState({ bootAttempts: 0, pendingVersion: '', rolledBackAt: new Date().toISOString() });
  return true;
}

// ===== 3. 主流程 =====

function pickContentDir() {
  if (!canUpdate) return bundledContent; // 便携版/解压版：程序目录本身就是内容
  const currentDir = path.join(appRoot, 'current');
  const stagedDir = path.join(appRoot, 'staged');

  // 首次运行：把自带内容复制到用户目录，之后增量更新都作用于这份
  if (!isContentDir(currentDir)) {
    if (fileExists(path.join(appRoot, 'state.json')) || dirExists(currentDir)) {
      // 有残留但不完整（可能被中断）→ 清掉重建
      try {
        fs.rmSync(currentDir, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    }
    try {
      fs.mkdirSync(currentDir, { recursive: true });
      for (const rel of listFiles(bundledContent)) {
        if (rel === 'bootstrap.js') continue;
        copyFile(path.join(bundledContent, rel), path.join(currentDir, rel));
      }
      console.log('[boot] 已把自带内容复制到 ' + currentDir);
    } catch (e) {
      console.warn('[boot] 复制自带内容失败，本次直接用自带内容运行：', e && e.message);
      return bundledContent;
    }
  }

  if (maybeRollback(currentDir)) return isContentDir(currentDir) ? currentDir : bundledContent;

  // 有待生效的更新 → 现在应用（启动最早期，没有文件占用问题）
  if (fileExists(path.join(stagedDir, '.ready'))) {
    try {
      applyStaged(currentDir, stagedDir);
      writeAppState({ bootAttempts: 0, pendingVersion: '' });
    } catch (e) {
      console.warn('[boot] 应用更新失败，继续用旧版本：', e && e.message);
    }
  }

  if (!isContentDir(currentDir)) return bundledContent;
  // 记录本次启动尝试（main.js 成功加载界面后会清零；连续两次失败就回退）
  const st = readAppState();
  writeAppState({ ...st, bootAttempts: Number(st.bootAttempts || 0) + 1 });
  return currentDir;
}

const contentDir = pickContentDir();

// 内容目录在用户目录里，Node 默认找不到程序目录下的 node_modules（ws / electron-updater），
// 用 NODE_PATH 指过去，免得把 9MB 依赖在"引擎"和"内容"里各放一份。
process.env.NODE_PATH = [path.join(__dirname, 'node_modules'), process.env.NODE_PATH || '']
  .filter(Boolean)
  .join(path.delimiter);
try {
  require('module').Module._initPaths();
} catch (e) {
  console.warn('[boot] 设置 NODE_PATH 失败：', e && e.message);
}

// 传给主进程：内容根目录 / 当前内容版本 / 更新状态文件位置
process.env.LYCEE_CONTENT_ROOT = contentDir;
process.env.LYCEE_APP_ROOT = canUpdate ? appRoot : '';
const contentState = readState(contentDir);
if (contentState && contentState.version) process.env.LYCEE_CONTENT_VERSION = String(contentState.version);
process.env.LYCEE_CAN_UPDATE = canUpdate ? '1' : '0';

try {
  require(path.join(contentDir, 'dist-electron', 'main.js'));
} catch (e) {
  console.error('[boot] 加载主进程失败：', e);
  // 起不来时至少让用户看到原因
  try {
    const { dialog, app: a } = require('electron');
    a.whenReady().then(() =>
      dialog.showErrorBox('启动失败', '游戏内容加载失败：\n' + (e && e.stack ? e.stack : String(e)) + '\n\n可在「控制面板 → 卸载程序」重装，或把 %APPDATA%\\lycee-overture-battle\\app 删掉后重开。'),
    );
  } catch {
    /* 忽略 */
  }
}
