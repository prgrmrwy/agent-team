/**
 * Markdown 工具。具体渲染用 react-markdown + rehype-highlight，
 * 此处只提供纯字符串处理辅助函数。
 */

/** 截取 markdown 的前 N 个字符，不破坏中文字符，返回纯文本摘要。 */
export function excerptMarkdown(md: string, maxLen = 120): string {
  // 粗处理：去掉 heading # / emphasis * / code ` / links [] ()
  const text = md
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*{1,3}([^*]*)\*{1,3}/g, '$1')
    .replace(/`[^`]*`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\n+/g, ' ')
    .trim()

  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}…`
}

/** 判断字符串是否看起来像 Markdown（有标题/列表/代码块）。 */
export function looksLikeMarkdown(s: string): boolean {
  return /^#{1,6}\s|^\s*[-*+]\s|^```/m.test(s)
}
