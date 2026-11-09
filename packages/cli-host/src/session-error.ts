// 用途：C1 演进（#41）—— session_error.code 归类助手：三 CLI 协议层报错的认证失效/协议断连判定。
// 这是 Adapter 侧协议级检测（判定的输入是协议错误载荷：JSON-RPC error / stream-json result / HTTP 状态码与响应体），
// 不是 renderer 消息关键词启发式（spec #40 B 节禁止项）。样本依据：docs/acceptance/stage4/auth-samples.md。

/** HTTP 状态码级认证失效判定（opencode HTTP 响应 / claude result.api_error_status） */
export function isAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/** 认证失效报错文本标记（三 CLI 协议错误原文并集，大小写不敏感；矩阵中标注了每条来源） */
const AUTH_TEXT_MARKERS: RegExp[] = [
  /failed to authenticate/i, // claude 2.1.317 真实触发（auth-samples.md）
  /api error:? ?40[13]/i, // claude「API Error: 401 …」真实触发
  /\bhttp 40[13]\b/i, // opencode 非 2xx 响应包装文本「HTTP 401 …」（构造样本）
  /unauthorized/i,
  /invalid[ _-]api[ _-]?key/i, // 各家 401 响应体通称
  /incorrect api key/i, // anthropic/openai 401 响应体
  /invalid x-api-key/i, // anthropic 401 响应体
  /authentication (error|failed)/i,
  /please (log|sign)[ -]?in/i, // codex 登录指引文案（构造样本）
  /not logged in/i, // codex login status 输出（真实触发取证）
  /log in with chatgpt/i, // codex chatgpt 登录态文案（构造样本）
  /login (expired|required)/i,
];

/** 文本级认证失效判定（协议错误 message/result 文本兜底；结构化状态码优先） */
export function isAuthFailureText(text: string): boolean {
  return AUTH_TEXT_MARKERS.some((re) => re.test(text));
}

/** 协议传输断连文本标记（opencode HTTP/SSE 形态：本地 server 不可达 / 连接被对端关闭） */
const DISCONNECT_TEXT_MARKERS: RegExp[] = [
  /server (?:已断开|请求失败)/, // opencode client.ts 抛错原文
  /fetch failed/i,
  /econnrefused/i,
  /socket hang up/i,
  /connection (?:refused|reset|closed|terminated)/i,
];

/** 文本级协议断连判定（turn 提交/命令执行时传输不可达 → PROTOCOL_DISCONNECT，US 12） */
export function isProtocolDisconnectText(text: string): boolean {
  return DISCONNECT_TEXT_MARKERS.some((re) => re.test(text));
}
