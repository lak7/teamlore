'use strict';

const fs = require('fs');
const path = require('path');
const ui = require('./ui');
const { SKILL_DIR, HOST_IDS } = require('./constants');

/*
 * Shared toolkit for the per-host adapters (lib/adapters/*.js).
 *
 * Plain functions only. Every config write goes through writeAtomic
 * (tmp file + rename) so a crash can never leave a half-written config.
 */

// Project-relative skill dir each host reads its teamlore copy from.
// cursor/opencode share the claude copy (both load .claude/skills natively);
// zcode/kimi get their own family copy (hosted under their own dot-dir).
const HOST_SKILL_DIRS = {
  claude: SKILL_DIR,
  cursor: SKILL_DIR,
  opencode: SKILL_DIR,
  zcode: '.zcode/skills/teamlore',
  kimi: '.kimi-code/skills/teamlore',
};

// The literal path prefix rewritten inside SKILL.md when copying the skill
// for a non-claude family (identity for claude/cursor/opencode).
const SKILL_PATH_PREFIX = '.claude/skills/teamlore/';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Atomic write: write a sibling tmp file, then rename over the destination.
function writeAtomic(filePath, content) {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2);
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* best effort */
    }
    throw err;
  }
}

// Returns 'created' | 'updated' | 'unchanged' | 'skipped' (same idiom as init.js).
function writeIfChanged(dest, content, { overwrite }) {
  const exists = fs.existsSync(dest);
  if (exists && !overwrite) return 'skipped';
  if (exists) {
    if (fs.readFileSync(dest, 'utf8') === content) return 'unchanged';
    writeAtomic(dest, content);
    return 'updated';
  }
  writeAtomic(dest, content);
  return 'created';
}

// Recursively copy a template dir. `rewrite` optionally maps file content
// (relative dest path -> content) before writing.
function copyTree(srcDir, destDir, overwrite, stats, rewrite) {
  ensureDir(destDir);
  for (const name of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, name);
    const dest = path.join(destDir, name);
    if (fs.statSync(src).isDirectory()) {
      copyTree(src, dest, overwrite, stats, rewrite);
    } else {
      let content = fs.readFileSync(src, 'utf8');
      if (rewrite) content = rewrite(name, content) || content;
      const status = writeIfChanged(dest, content, { overwrite });
      stats[status] = (stats[status] || 0) + 1;
    }
  }
}

// Copy the skill templates into `destSkillDir`. `skillDirRel` is the host's
// project-relative skill dir (e.g. '.zcode/skills/teamlore') used ONLY for
// the SKILL.md path rewrite: the literal `.claude/skills/teamlore/` prefix
// becomes `<skillDirRel>/` (identity for the claude family). The rewrite is
// always relative so committed copies stay machine-independent.
function copySkill(destSkillDir, templatesDir, skillDirRel) {
  const rel = skillDirRel || SKILL_DIR;
  const stats = {};
  copyTree(path.join(templatesDir, 'skill'), destSkillDir, true, stats, (name, content) => {
    if (name !== 'SKILL.md' || rel === SKILL_DIR) return content;
    return content.split(SKILL_PATH_PREFIX).join(rel + '/');
  });
  return stats;
}

// Ensure the shared claude-family skill copy exists at <root>/SKILL_DIR
// (cursor and opencode read it natively — never a second family copy).
function ensureClaudeSkillCopy(root, templatesDir) {
  return copySkill(path.join(root, SKILL_DIR), templatesDir, SKILL_DIR);
}

// Standard row for a skill-copy step (same style as init.js's skill row).
function skillRow(stats, label, filePath) {
  const { green, dim } = ui;
  const created = stats.created || 0;
  const updated = stats.updated || 0;
  return {
    changed: created + updated > 0,
    label,
    filePath,
    note: created ? green(created + ' files') : updated ? green(updated + ' updated') : dim('up to date'),
  };
}

// True when the given path (relative or absolute) is one of the teamlore
// sentinel gitignore lines a family may have added.
function isTeamloreGitignoreLine(line) {
  return /\.claude\/skills\/teamlore\/\.needs-distill$/.test(line) ||
    /\.zcode\/skills\/teamlore\/\.needs-distill$/.test(line) ||
    /\.kimi-code\/skills\/teamlore\/\.needs-distill$/.test(line);
}

function ensureGitignoreLine(gitignorePath, line) {
  let content = '';
  try {
    content = fs.readFileSync(gitignorePath, 'utf8');
  } catch (_) {
    content = '';
  }
  const lines = content.split('\n').map((l) => l.trim());
  if (lines.includes(line)) return false;
  const prefix = content && !content.endsWith('\n') ? '\n' : '';
  const header = content.includes('# teamlore') ? '' : '\n# teamlore\n';
  fs.appendFileSync(gitignorePath, prefix + header + line + '\n');
  return true;
}

// Remove specific sentinel lines from .gitignore; the `# teamlore` header is
// only dropped when no family's sentinel line remains. Other entries intact.
function cleanGitignoreLines(gitignorePath, removeLines) {
  let content;
  try {
    content = fs.readFileSync(gitignorePath, 'utf8');
  } catch (_) {
    return false;
  }
  const lines = content.split('\n');
  const removeSet = new Set(removeLines.map((l) => l.trim()));
  const kept = lines.filter((l) => !removeSet.has(l.trim()));
  if (kept.length === lines.length) return false;
  const final = kept.some((l) => isTeamloreGitignoreLine(l.trim()))
    ? kept
    : kept.filter((l) => l.trim() !== '# teamlore');
  const text = final.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
  writeAtomic(gitignorePath, text);
  return true;
}

function rmrf(target) {
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

// Adapter registry. Required lazily so adapters can require this module.
function loadAdapters() {
  return HOST_IDS.map((id) => require('./adapters/' + id));
}

module.exports = {
  HOST_SKILL_DIRS,
  SKILL_PATH_PREFIX,
  ensureDir,
  writeAtomic,
  writeIfChanged,
  copyTree,
  copySkill,
  ensureClaudeSkillCopy,
  skillRow,
  isTeamloreGitignoreLine,
  ensureGitignoreLine,
  cleanGitignoreLines,
  rmrf,
  loadAdapters,
};
