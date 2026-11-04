/**
 * 维度配色：按维度列表顺序取色，保证同一页里的维度彼此不同色；
 * 「未分类」固定中性灰。色板只放浅底 + 深字，避免抢走任务标题的注意力。
 */
export type DimensionTone = { background: string; color: string };

const TONES: DimensionTone[] = [
  { background: "#e9edf9", color: "#33438c" },
  { background: "#fff7e6", color: "#d46b08" },
  { background: "#f6ffed", color: "#389e0d" },
  { background: "#f9f0ff", color: "#531dab" },
  { background: "#fff0f6", color: "#c41d7f" },
  { background: "#e6fffb", color: "#08979c" },
  { background: "#fffbe6", color: "#ad6800" },
  { background: "#fff1f0", color: "#cf1322" },
];

const UNCLASSIFIED: DimensionTone = { background: "#f5f5f5", color: "#595959" };

/** id → 颜色；顺序与 `listTaskDimensions()` 一致，新增维度排在后面不会改变已有颜色 */
export function dimensionTones(ids: string[]): Record<string, DimensionTone> {
  const tones: Record<string, DimensionTone> = {};
  ids.forEach((id, index) => {
    tones[id] = TONES[index % TONES.length]!;
  });
  tones.unclassified = UNCLASSIFIED;
  return tones;
}
