#!/usr/bin/env node
/**
 * EmbyX 双语同步脚本
 * 用法：node scripts/sync.js <command>
 *   extract  — 提取 zh 中的中文字符串到 i18n/*.json
 *   diff     — 对比 zh 与 en 的文本差异
 *   apply    — 用 zh + 翻译字典生成 en 文件
 *   check    — 校验翻译字典一致性
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const I18N_DIR = path.join(ROOT, 'i18n');

// 需要同步的文件映射
const SYNC_FILES = [
  { zh: 'zh/index.html', en: 'en/index.html', i18n: 'index.json' },
  { zh: 'zh/pic.html', en: 'en/pic.html', i18n: 'pic.json' },
  { zh: 'zh/info.html', en: 'en/info.html', i18n: 'info.json' },
];

// ═══════════════════════════════════════
// § 1. 文案提取
// ═══════════════════════════════════════

/**
 * 从文件中提取包含中文的字符串
 * 返回 Map<原文, 出现次数>
 */
function extractChineseStrings(content) {
  const strings = new Map();

  const patterns = [
    // showToast('文案') / prompt('文案') 等函数调用
    /(?:showToast|prompt|confirm)\s*\(\s*['"`]([^'"`]*[\u4e00-\u9fff][^'"`]*?)['"`]/g,
    // textContent = '文案'
    /\.(?:textContent|innerText)\s*=\s*['"`]([^'"`]*[\u4e00-\u9fff][^'"`]*?)['"`]/g,
    // .innerHTML = `...中文...`
    /\.innerHTML\s*=\s*`([^`]*[\u4e00-\u9fff][^`]*)`/g,
    // placeholder="中文"
    /placeholder\s*=\s*["']([^"']*[\u4e00-\u9fff][^"']*)/g,
    // title="中文"
    /title\s*=\s*["']([^"']*[\u4e00-\u9fff][^"']*)/g,
    // <title>中文</title>
    /<title>([^<]*[\u4e00-\u9fff][^<]*)<\/title>/g,
    // HTML 标签内的纯文本
    />([^<]*[\u4e00-\u9fff][^<]*)</g,
    // const/let/var 赋值含中文
    /(?:const|let|var)\s+\w+\s*=\s*['"`]([^'"`]*[\u4e00-\u9fff][^'"`]*?)['"`]/g,
    // return '中文'
    /return\s+['"`]([^'"`]*[\u4e00-\u9fff][^'"`]*?)['"`]/g,
    // case '中文':
    /case\s+['"`]([^'"`]*[\u4e00-\u9fff][^'"`]*?)['"`]/g,
    // console.warn/error('中文')
    /console\.\w+\s*\(\s*['"`]([^'"`]*[\u4e00-\u9fff][^'"`]*?)['"`]/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const str = match[1].trim();
      if (str && str.length > 0 && /[\u4e00-\u9fff]/.test(str)) {
        strings.set(str, (strings.get(str) || 0) + 1);
      }
    }
  }

  return strings;
}

function isValidString(str) {
  // 跳过纯标点/数字/空白
  if (/^[\s\d\.,;:!?，。；：！？、\-\+\/\\=<>{}[\]()（）【】「」]+$/.test(str)) return false;
  // 跳过太短的
  if (str.length < 2) return false;
  // 跳过包含换行的（HTML 模板块）
  if (str.includes("\n")) return false;
  // 跳过包含 HTML 标签的
  if (/<[a-zA-Z]/.test(str)) return false;
  // 跳过太长的（>100 字符基本是代码块）
  if (str.length > 100) return false;
  // 跳过包含 CSS class 或 HTML 属性的
  if (/class=|data-|style=|onclick|href=/.test(str)) return false;
  // 必须包含中文
  if (!/[\u4e00-\u9fff]/.test(str)) return false;
  return true;
}

// ═══════════════════════════════════════
// § 2. 命令实现
// ═══════════════════════════════════════

function cmdExtract() {
  console.log('══ 提取中文文案 ══\n');

  for (const file of SYNC_FILES) {
    const zhPath = path.join(ROOT, file.zh);
    const i18nPath = path.join(I18N_DIR, file.i18n);

    if (!fs.existsSync(zhPath)) {
      console.log(`⚠ ${file.zh} 不存在，跳过`);
      continue;
    }

    const content = fs.readFileSync(zhPath, 'utf-8');
    const extracted = extractChineseStrings(content);

    const validStrings = new Map();
    for (const [str, count] of extracted) {
      if (isValidString(str)) {
        validStrings.set(str, count);
      }
    }

    let existing = {};
    if (fs.existsSync(i18nPath)) {
      existing = JSON.parse(fs.readFileSync(i18nPath, 'utf-8'));
    }
    const existingStrings = existing.strings || {};

    const newStrings = [];
    const keptStrings = [];

    for (const [str, count] of validStrings) {
      if (str in existingStrings) {
        keptStrings.push(str);
      } else {
        newStrings.push({ str, count });
      }
    }

    const removed = [];
    for (const key of Object.keys(existingStrings)) {
      if (!validStrings.has(key) && !key.startsWith('_')) {
        removed.push(key);
      }
    }

    console.log(`📄 ${file.zh}`);
    console.log(`   提取 ${validStrings.size} 条中文字符串`);
    if (newStrings.length > 0) {
      console.log(`   🆕 新增 ${newStrings.length} 条：`);
      for (const { str, count } of newStrings) {
        console.log(`      "${str}" (${count}次)`);
      }
    }
    if (removed.length > 0) {
      console.log(`   🗑️  废弃 ${removed.length} 条：`);
      for (const str of removed) {
        console.log(`      "${str}"`);
      }
    }
    if (newStrings.length === 0 && removed.length === 0) {
      console.log('   ✅ 无变化');
    }

    const updatedStrings = {};
    for (const [str] of validStrings) {
      updatedStrings[str] = existingStrings[str] !== undefined ? existingStrings[str] : '';
    }

    const output = {
      _meta: {
        source: file.zh,
        target: file.en,
        updated: new Date().toISOString().slice(0, 10),
      },
      strings: updatedStrings,
    };

    fs.mkdirSync(I18N_DIR, { recursive: true });
    fs.writeFileSync(i18nPath, JSON.stringify(output, null, 2) + '\n');
    console.log(`   💾 已更新 ${file.i18n}\n`);
  }
}

function cmdDiff() {
  console.log('══ 文本差异对比 ══\n');

  for (const file of SYNC_FILES) {
    const zhPath = path.join(ROOT, file.zh);
    const enPath = path.join(ROOT, file.en);
    const i18nPath = path.join(I18N_DIR, file.i18n);

    if (!fs.existsSync(zhPath) || !fs.existsSync(enPath)) {
      console.log(`⚠ ${file.zh} 或 ${file.en} 不存在，跳过`);
      continue;
    }

    const i18n = fs.existsSync(i18nPath)
      ? JSON.parse(fs.readFileSync(i18nPath, 'utf-8'))
      : { strings: {} };
    const translations = i18n.strings || {};

    const zhContent = fs.readFileSync(zhPath, 'utf-8');
    const enContent = fs.readFileSync(enPath, 'utf-8');

    const zhStrings = extractChineseStrings(zhContent);
    const enStrings = extractChineseStrings(enContent);

    const validZh = new Map();
    for (const [str, count] of zhStrings) {
      if (isValidString(str)) validZh.set(str, count);
    }
    const validEn = new Map();
    for (const [str, count] of enStrings) {
      if (isValidString(str)) validEn.set(str, count);
    }

    const needTranslation = [];
    for (const [str] of validZh) {
      if (!validEn.has(str) && translations[str]) {
        needTranslation.push({ zh: str, en: translations[str] });
      } else if (!validEn.has(str)) {
        needTranslation.push({ zh: str, en: '(未翻译)' });
      }
    }

    const residualChinese = [];
    for (const [str] of validEn) {
      if (validZh.has(str)) {
        residualChinese.push(str);
      }
    }

    console.log(`📄 ${file.zh} vs ${file.en}`);
    if (needTranslation.length > 0) {
      console.log(`   📝 需要翻译 ${needTranslation.length} 条：`);
      for (const { zh, en } of needTranslation.slice(0, 10)) {
        console.log(`      "${zh}" → "${en}"`);
      }
      if (needTranslation.length > 10) {
        console.log(`      ... 还有 ${needTranslation.length - 10} 条`);
      }
    }
    if (residualChinese.length > 0) {
      console.log(`   ⚠️  en 中残留中文 ${residualChinese.length} 条：`);
      for (const str of residualChinese.slice(0, 5)) {
        console.log(`      "${str}"`);
      }
    }
    if (needTranslation.length === 0 && residualChinese.length === 0) {
      console.log('   ✅ 无差异');
    }
    console.log('');
  }
}

function cmdApply() {
  console.log('══ 生成 en 文件 ══\n');

  for (const file of SYNC_FILES) {
    const zhPath = path.join(ROOT, file.zh);
    const enPath = path.join(ROOT, file.en);
    const i18nPath = path.join(I18N_DIR, file.i18n);

    if (!fs.existsSync(zhPath)) {
      console.log(`⚠ ${file.zh} 不存在，跳过`);
      continue;
    }
    if (!fs.existsSync(i18nPath)) {
      console.log(`⚠ ${file.i18n} 不存在，先运行 extract`);
      continue;
    }

    const i18n = JSON.parse(fs.readFileSync(i18nPath, 'utf-8'));
    const translations = i18n.strings || {};
    let content = fs.readFileSync(zhPath, 'utf-8');

    let replaceCount = 0;
    let missingCount = 0;

    // 按 key 长度降序排列，避免短串先替换导致长串匹配失败
    const sortedKeys = Object.keys(translations)
      .filter(k => translations[k] && translations[k].length > 0)
      .sort((a, b) => b.length - a.length);

    for (const zhStr of sortedKeys) {
      const enStr = translations[zhStr];
      if (!enStr || enStr.length === 0) continue;

      const escaped = zhStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'g');
      const before = content;
      content = content.replace(regex, enStr);
      if (content !== before) {
        replaceCount += (before.match(regex) || []).length;
      }
    }

    for (const zhStr of Object.keys(translations)) {
      if (!translations[zhStr] || translations[zhStr].length === 0) {
        if (content.includes(zhStr)) {
          missingCount++;
        }
      }
    }

    // 特殊替换
    content = content.replace(/lang="zh-CN"/g, 'lang="en"');
    content = content.replace(/lang="zh"/g, 'lang="en"');
    content = content.replace(
      /探索更多：谢週五の藏经阁 \(https:\/\/5nav\.eu\.org\)/g,
      'Made with ❤️ by Juneix (https://github.com/juneix)'
    );
    content = content.replace(
      /著作权所有·设计与开发/g,
      'All Rights Reserved'
    );

    // 保护 en 专属的社媒与 Get Involved 区域
    const enSocialBlock = `<div>
                                <h4 class="text-gray-300">🚀 Get Involved</h4>
                                <ul class="list-disc list-inside space-y-1 text-gray-400 text-xs mt-3">
                                    <li><span class="text-gray-300 font-medium">Community:</span> Follow the latest updates.</li>
                                    <li><span class="text-gray-300 font-medium">Support:</span> Help me build more cool stuff.</li>
                                </ul>
                                <div class="grid grid-cols-2 md:grid-cols-4 gap-2 mt-4">
                                    <a href="https://x.com/juneix_tse" target="_blank"
                                        class="flex items-center justify-center text-white bg-white/10 hover:bg-white/20 px-3 h-11 rounded-full transition-colors border border-white/20 text-[10px] whitespace-nowrap">
                                        <img src="https://cdn.simpleicons.org/x/white" class="w-3.5 h-3.5 mr-1.5"
                                            alt="X" /> Twitter • Follow</a>
                                    <a href="https://t.me/juneix_en" target="_blank"
                                        class="flex items-center justify-center text-[#26A5E4] bg-[#26A5E4]/10 hover:bg-[#26A5E4]/20 px-3 h-11 rounded-full transition-colors border border-[#26A5E4]/20 text-[10px] whitespace-nowrap">
                                        <img src="https://cdn.simpleicons.org/telegram/26A5E4"
                                            class="w-3.5 h-3.5 mr-1.5" alt="Telegram" /> Telegram • Channel</a>
                                    <a href="https://ko-fi.com/juneixtse" target="_blank"
                                        class="flex items-center justify-center text-[#FF6433] bg-[#FF5E5B]/10 hover:bg-[#FF5E5B]/20 px-3 h-11 rounded-full transition-colors border border-[#FF5E5B]/20 text-[10px] whitespace-nowrap">
                                        <img src="https://cdn.simpleicons.org/kofi/FF6433" class="w-3.5 h-3.5 mr-1.5"
                                            alt="Ko-fi" /> Ko-fi • Support</a>
                                    <a href="https://github.com/juneix/embyx" target="_blank"
                                        class="flex items-center justify-center text-white bg-white/10 hover:bg-white/20 px-3 h-11 rounded-full transition-colors border border-white/20 text-[10px] whitespace-nowrap active:scale-95">
                                        <img src="https://cdn.simpleicons.org/github/white" class="w-3.5 h-3.5 mr-1.5"
                                            alt="GitHub" /> GitHub • Stars</a>
                                </div>
                            </div>

                            <div
                                class="pt-4 border-t border-gray-700/50 text-xs text-gray-500 text-center flex flex-col space-y-1">
                                <p>Made with ❤️ by <a href="https://juneix.github.io" target="_blank"
                                        class="text-primary hover:underline">Juneix</a></p>
                                <p>© 2026 All Rights Reserved</p>
                            </div>`;

    content = content.replace(/<!-- i18n:social-block-start -->[\s\S]*?<!-- i18n:social-block-end -->/g, enSocialBlock);

    fs.mkdirSync(path.dirname(enPath), { recursive: true });
    fs.writeFileSync(enPath, content);

    console.log(`📄 ${file.zh} → ${file.en}`);
    console.log(`   ✅ 替换 ${replaceCount} 处`);
    if (missingCount > 0) {
      console.log(`   ⚠️  ${missingCount} 条未翻译（保留中文）`);
    }
    console.log('');
  }

  console.log('完成！请在浏览器中验证 en 版本。');
}

function cmdCheck() {
  console.log('══ 校验翻译一致性 ══\n');

  let totalOk = 0;
  let totalMissing = 0;
  let totalStale = 0;

  for (const file of SYNC_FILES) {
    const zhPath = path.join(ROOT, file.zh);
    const i18nPath = path.join(I18N_DIR, file.i18n);

    if (!fs.existsSync(zhPath) || !fs.existsSync(i18nPath)) {
      console.log(`⚠ ${file.zh} 或 ${file.i18n} 不存在，跳过`);
      continue;
    }

    const content = fs.readFileSync(zhPath, 'utf-8');
    const i18n = JSON.parse(fs.readFileSync(i18nPath, 'utf-8'));
    const translations = i18n.strings || {};

    const zhStrings = extractChineseStrings(content);
    const validZh = new Map();
    for (const [str, count] of zhStrings) {
      if (isValidString(str)) validZh.set(str, count);
    }

    const missing = [];
    for (const [str] of validZh) {
      if (!translations[str] || translations[str].length === 0) {
        missing.push(str);
      }
    }

    const stale = [];
    for (const key of Object.keys(translations)) {
      if (key.startsWith('_')) continue;
      if (!validZh.has(key)) {
        stale.push(key);
      }
    }

    console.log(`📄 ${file.i18n}`);
    if (missing.length > 0) {
      console.log(`   ❌ 缺失翻译 ${missing.length} 条：`);
      for (const str of missing.slice(0, 5)) {
        console.log(`      "${str}"`);
      }
      if (missing.length > 5) console.log(`      ... 还有 ${missing.length - 5} 条`);
    }
    if (stale.length > 0) {
      console.log(`   🗑️  过期条目 ${stale.length} 条：`);
      for (const str of stale.slice(0, 5)) {
        console.log(`      "${str}"`);
      }
    }
    if (missing.length === 0 && stale.length === 0) {
      console.log('   ✅ 一致');
    }
    console.log('');

    totalOk += missing.length === 0 && stale.length === 0 ? 1 : 0;
    totalMissing += missing.length;
    totalStale += stale.length;
  }

  console.log('─── 汇总 ───');
  console.log(`   文件：${SYNC_FILES.length}，一致：${totalOk}`);
  console.log(`   缺失翻译：${totalMissing}，过期条目：${totalStale}`);
  if (totalMissing === 0 && totalStale === 0) {
    console.log('   🎉 全部通过');
  }
}

// ═══════════════════════════════════════
// § 3. 入口
// ═══════════════════════════════════════

const cmd = process.argv[2];
const commands = { extract: cmdExtract, diff: cmdDiff, apply: cmdApply, check: cmdCheck };

if (!cmd || !commands[cmd]) {
  console.log('EmbyX 双语同步脚本\n');
  console.log('用法：node scripts/sync.js <command>\n');
  console.log('命令：');
  console.log('  extract  提取 zh 中的中文字符串到 i18n/*.json');
  console.log('  diff     对比 zh 与 en 的文本差异');
  console.log('  apply    用 zh + 翻译字典生成 en 文件');
  console.log('  check    校验翻译字典一致性');
  process.exit(1);
}

commands[cmd]();
