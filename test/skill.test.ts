import assert from "node:assert/strict";
import test from "node:test";
import { compactSkillBlock } from "../src/skill.ts";

const block = (name: string, body = "技能正文\n第二行", rest?: string) =>
  `<skill name="${name}" location="/home/u/.pi/agent/skills/${name}/SKILL.md">\n${body}\n</skill>` +
  (rest === undefined ? "" : `\n\n${rest}`);

test("compactSkillBlock：整条就是技能正文时缩成 /skill:name", () => {
  assert.equal(compactSkillBlock(block("code-review")), "/skill:code-review");
});

test("compactSkillBlock：技能后面用户自己写的话原样留着", () => {
  assert.equal(compactSkillBlock(block("tdd", "正文", "给登录加个测试")), "/skill:tdd\n\n给登录加个测试");
  // 用户的话里有多余空行也清掉，但内容不动
  assert.equal(compactSkillBlock(block("tdd", "正文", "\n  给登录加个测试 \n\n")), "/skill:tdd\n\n给登录加个测试");
});

test("compactSkillBlock：不是技能消息就原样返回", () => {
  for (const t of ["普通提问", "", "<skill 没有闭合", "看着像技能但不在开头 <skill name=\"x\" location=\"y\">\n正文\n</skill>"]) {
    assert.equal(compactSkillBlock(t), t);
  }
  // 缺 location 属性、名字为空都不算 pi 的格式，不冒险乱缩
  assert.equal(compactSkillBlock('<skill name="x">\n正文\n</skill>'), '<skill name="x">\n正文\n</skill>');
});

test("compactSkillBlock：正文里的反引号、代码块和尖括号不影响识别", () => {
  const body = "## 步骤\n\n```bash\ngit status\n```\n\n用 `</skill>` 这种字符串也不行";
  assert.equal(compactSkillBlock(`<skill name="ce" location="/l">\n${body}\n</skill>`), "/skill:ce");
});
