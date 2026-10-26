// pi 调用技能时，会把技能正文整段塞进用户消息里：
//   <skill name="code-review" location="…/SKILL.md">\n…正文…\n</skill>
// 后面可能还跟着用户自己写的一句话（中间空一行）。正文动辄几千字，直接显示会把预览和
// "首条 / 最近一条提问"撑爆。显示时把它缩成 /skill:name，用户自己写的那句原样留在后面。
//
// 正则和 pi 自己的 parseSkillBlock 保持一致（pi 的 dist/core/agent-session.js 和导出 HTML 的模板里），
// 免得我们认得出、pi 认不出，或者反过来。
const SKILL_BLOCK = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** 开头的技能块换成 /skill:name；没有技能块就原样返回 */
export function compactSkillBlock(text: string): string {
  const m = text.match(SKILL_BLOCK);
  if (!m) return text;
  const rest = m[4]?.trim();
  return rest ? `/skill:${m[1]}\n\n${rest}` : `/skill:${m[1]}`;
}
