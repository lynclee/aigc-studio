/**
 * 飞书(Lark)OAuth 2.0 网页登录封装。
 *
 * 采用飞书开放平台「自建应用 / 用户身份验证 OAuth 2.0」(v2 token endpoint)流程,
 * 文档出处(2026-06,open.feishu.cn):
 *  1. 获取授权码 authorization code(浏览器 302 到授权页):
 *     GET https://accounts.feishu.cn/open-apis/authen/v1/authorize
 *       ?client_id=<APP_ID>&redirect_uri=<ENCODED>&response_type=code&scope=<scopes>&state=<state>
 *     文档:https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code
 *  2. code 换 user_access_token(v2,JSON body,无需先取 app_access_token):
 *     POST https://open.feishu.cn/open-apis/authen/v2/oauth/token
 *     Content-Type: application/json; charset=utf-8
 *     body: { grant_type:"authorization_code", client_id, client_secret, code, redirect_uri }
 *     文档:https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token
 *  3. user_access_token 拿用户信息(name / open_id / avatar_url):
 *     GET https://open.feishu.cn/open-apis/authen/v1/user_info
 *     Header: Authorization: Bearer <user_access_token>
 *     文档:https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/user_info/get
 *
 * 选型说明:token 交换用 v2 endpoint(authen/v2/oauth/token)——它是飞书当前推荐的
 * 标准 OAuth 2.0,直接收 client_id/client_secret,不需要 v1 那样先单独取 app_access_token;
 * user_info 端点 v1/v2 一致(authen/v1/user_info),返回 name/open_id/avatar_url 等。
 */

const AUTHORIZE_ENDPOINT = "https://accounts.feishu.cn/open-apis/authen/v1/authorize"
const TOKEN_ENDPOINT = "https://open.feishu.cn/open-apis/authen/v2/oauth/token"
const USER_INFO_ENDPOINT = "https://open.feishu.cn/open-apis/authen/v1/user_info"

/** 默认申请的 scope:拿到基础用户身份信息即可。 */
const DEFAULT_SCOPE = "contact:user.base:readonly"

export interface LarkConfig {
  appId: string
  appSecret: string
  redirectUri: string
}

export interface LarkUserInfo {
  name: string
  open_id: string
  /** 头像 URL(飞书 user_info 返回 avatar_url) */
  avatar_url: string
}

/** 从环境变量读取飞书 OAuth 配置;缺失项以空串占位(P2 填真凭据)。 */
export function getLarkConfig(): LarkConfig {
  return {
    appId: process.env.LARK_APP_ID ?? "",
    appSecret: process.env.LARK_APP_SECRET ?? "",
    redirectUri: process.env.LARK_REDIRECT_URI ?? "",
  }
}

/**
 * 构造飞书授权页 URL —— 浏览器 302 到此地址,用户同意后飞书带 ?code&state 回跳 redirect_uri。
 */
export function buildAuthorizeUrl(state: string, scope: string = DEFAULT_SCOPE): string {
  const { appId, redirectUri } = getLarkConfig()
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  })
  if (scope) params.set("scope", scope)
  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`
}

interface TokenResponse {
  code?: number
  msg?: string
  access_token?: string
  expires_in?: number
  refresh_token?: string
  token_type?: string
  scope?: string
  error?: string
  error_description?: string
}

/**
 * 用 authorization code 换 user_access_token(v2 endpoint)。
 * 失败抛 Error(含飞书返回的 msg/error_description)。
 */
export async function exchangeCodeForToken(code: string): Promise<string> {
  const { appId, appSecret, redirectUri } = getLarkConfig()

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: appId,
      client_secret: appSecret,
      code,
      redirect_uri: redirectUri,
    }),
    // OAuth 是运行时调用,关闭缓存
    cache: "no-store",
  })

  const data = (await res.json().catch(() => ({}))) as TokenResponse

  // v2 token endpoint 成功时 HTTP 200 且 code===0(或不带 code 字段但带 access_token)
  if (!res.ok || (typeof data.code === "number" && data.code !== 0) || !data.access_token) {
    const detail =
      data.error_description || data.msg || data.error || `HTTP ${res.status}`
    throw new Error(`飞书 token 交换失败:${detail}`)
  }

  return data.access_token
}

interface UserInfoResponse {
  code?: number
  msg?: string
  data?: {
    name?: string
    open_id?: string
    avatar_url?: string
  }
}

/**
 * 用 user_access_token 拿用户信息(name / open_id / avatar_url)。
 * 失败抛 Error。
 */
export async function fetchUserInfo(userAccessToken: string): Promise<LarkUserInfo> {
  const res = await fetch(USER_INFO_ENDPOINT, {
    method: "GET",
    headers: { Authorization: `Bearer ${userAccessToken}` },
    cache: "no-store",
  })

  const data = (await res.json().catch(() => ({}))) as UserInfoResponse

  if (!res.ok || data.code !== 0 || !data.data) {
    const detail = data.msg || `HTTP ${res.status}`
    throw new Error(`飞书 user_info 获取失败:${detail}`)
  }

  // open_id 是会话身份的主键,空值会签发"匿名"session 导致登录成功却进不去的死循环 —— 直接拒绝
  const openId = data.data.open_id
  if (typeof openId !== "string" || !openId.trim()) {
    throw new Error("lark userinfo missing open_id")
  }

  return {
    name: data.data.name ?? "",
    open_id: openId,
    avatar_url: data.data.avatar_url ?? "",
  }
}
