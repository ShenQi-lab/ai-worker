// Supabase Edge Function: AI 虚拟员工聊天核心接口
// 技术栈: Deno + Supabase + Coze(扣子) API

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0?target=deno";
import { SignJWT, importPKCS8 } from "https://esm.sh/jose@4.15.9?target=deno";

// ============================================================
// CORS Headers
// ============================================================
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ============================================================
// 环境变量
// ============================================================
const SUPABASE_URL = Deno.env.get("SB_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY")!;
const COZE_APP_ID = Deno.env.get("COZE_APP_ID")!;
const COZE_BOT_ID = Deno.env.get("COZE_BOT_ID")!;
const COZE_KID = Deno.env.get("COZE_KID")!;

// ============================================================
// Supabase Admin Client（绕过 RLS）
// ============================================================
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ============================================================
// 防刷辅助函数
// ============================================================
function getClientIP(req: Request): string | null {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0].trim();
  const xr = req.headers.get("x-real-ip");
  if (xr) return xr.trim();
  return null;
}

async function checkRateLimit(ip: string | null): Promise<boolean> {
  if (!ip) return true;
  const today = new Date().toISOString().split('T')[0] + 'T00:00:00Z';
  const { count, error } = await supabaseAdmin
    .from("rate_limit_logs")
    .select("*", { count: "exact", head: true })
    .eq("ip_address", ip)
    .gte("window_start", today);
  if (error) {
    console.error("rate limit check error:", error);
    return true;
  }
  return (count || 0) < 3;
}

async function recordRateLimit(ip: string | null, userId: string) {
  if (!ip) return;
  await supabaseAdmin.from("rate_limit_logs").insert({
    user_id: userId,
    ip_address: ip,
    window_start: new Date().toISOString(),
  });
}

// ============================================================
// 读取扣子私钥
// ============================================================
function loadPrivateKey(): string {
  return Deno.env.get('COZE_PRIVATE_KEY')!;
}

// ============================================================
// 生成扣子 OAuth2 JWT
// ============================================================
async function generateCozeJWT(): Promise<string> {
  const privateKeyPem = loadPrivateKey();
  const privateKey = await importPKCS8(privateKeyPem, "RS256");

  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: COZE_KID })
    .setIssuer(COZE_APP_ID)
    .setAudience("api.coze.cn")
    .setIssuedAt()
    .setExpirationTime("3600s")
    .setJti(crypto.randomUUID())
    .sign(privateKey);

  return jwt;
}

// ============================================================
// 换取扣子 Access Token
// ============================================================
async function getCozeAccessToken(): Promise<string> {
  const jwt = await generateCozeJWT();

  const resp = await fetch("https://api.coze.cn/api/permission/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      duration: "3600",
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Coze token request failed: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  if (!data.access_token) {
    throw new Error(`Coze token response missing access_token: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

// ============================================================
// 调用扣子 Bot Chat（v2 API，直接返回消息）
// ============================================================
async function callCozeBot(
  accessToken: string,
  userId: string,
  message: string
): Promise<string> {
  console.log("Calling Coze v2 API with bot_id:", COZE_BOT_ID, "user_id:", userId);

  const resp = await fetch("https://api.coze.cn/open_api/v2/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      bot_id: COZE_BOT_ID,
      user: userId,
      query: message,
      stream: false,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.log("Coze v2 API error:", resp.status, errText);
    throw new Error(`Coze v2 chat failed: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  console.log("Coze v2 response:", JSON.stringify(data));

  // v2 响应格式
  if (data.messages) {
    const assistantMsg = data.messages.find(
      (m: any) => m.role === "assistant" && m.type === "answer"
    );
    if (assistantMsg && assistantMsg.content) {
      return assistantMsg.content;
    }
  }

  if (data.data?.messages) {
    const assistantMsg = data.data.messages.find(
      (m: any) => m.role === "assistant"
    );
    if (assistantMsg && assistantMsg.content) {
      return assistantMsg.content;
    }
  }

  throw new Error(`Coze v2 response missing assistant message: ${JSON.stringify(data)}`);
}

// ============================================================
// 获取或初始化用户配额
// ============================================================
async function getOrCreateQuota(userId: string, clientIP: string | null) {
  // 先尝试查询
  let { data: quota, error } = await supabaseAdmin
    .from("user_quotas")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error && error.code === "PGRST116") {
    // 新用户，检查 IP 防刷
    const allowed = await checkRateLimit(clientIP);
    if (!allowed) {
      throw new Error("RATE_LIMITED:今日注册次数已达上限");
    }

    // 记录不存在，自动创建
    const { data: newQuota, error: insertError } = await supabaseAdmin
      .from("user_quotas")
      .insert({
        user_id: userId,
        remaining: 3,
        membership: "free",
        daily_used: 0,
        daily_reset_date: new Date().toISOString().split("T")[0],
      })
      .select()
      .single();

    if (insertError) throw insertError;
    quota = newQuota;

    // 记录本次注册到限流日志
    await recordRateLimit(clientIP, userId);
  } else if (error) {
    throw error;
  }

  return quota;
}

// ============================================================
// 风控校验
// ============================================================
async function checkRiskControl(quota: any, message: string): Promise<{ ok: boolean; status: number; error?: string }> {
  // a. 输入长度校验
  if (message.length > 2000) {
    return { ok: false, status: 413, error: "输入过长" };
  }

  // b. 单用户冷却（3 秒）
  if (quota.last_request_at) {
    const lastReq = new Date(quota.last_request_at).getTime();
    const now = Date.now();
    if (now - lastReq < 3000) {
      return { ok: false, status: 429, error: "点击太快了" };
    }
  }

  // c. 跨天重置
  const today = new Date().toISOString().split("T")[0];
  if (quota.daily_reset_date !== today) {
    // 在内存中先更新，后续会写回数据库
    quota.daily_used = 0;
    quota.daily_reset_date = today;
  }

  // d. 会员判断：总次数用完 或 到期
  if (quota.membership !== "free") {
    // 检查是否过期
    if (quota.expires_at && new Date(quota.expires_at) < new Date()) {
      return { ok: false, status: 403, error: "会员已过期，请续费" };
    }
    // 检查总次数是否用完
    const myPlan = await supabaseAdmin
      .from("pricing_plans")
      .select("total_limit")
      .eq("plan", quota.membership)
      .single();
    const totalLimit = myPlan.data?.total_limit || 999999;
    if ((quota.total_used || 0) >= totalLimit) {
      return { ok: false, status: 429, error: "会员次数已用完，请续费" };
    }
  } else {
    // 免费用户保持原逻辑：单日上限 3 次（通过 remaining 控制）
    if (quota.remaining <= 0) {
      return { ok: false, status: 403, error: "次数不足，请购买会员" };
    }
  }

  // e. 免费次数检查
  if (quota.membership === "free") {
    if (quota.remaining <= 0) {
      // 检查是否有过期时间且未过期（虽然 free 一般没有 expires_at，但做兜底）
      if (!quota.expires_at || new Date(quota.expires_at) < new Date()) {
        return { ok: false, status: 403, error: "次数不足，请购买会员" };
      }
    }
  } else {
    // 付费会员：检查是否过期
    if (quota.expires_at && new Date(quota.expires_at) < new Date()) {
      // 会员已过期，降级为免费并检查剩余次数
      if (quota.remaining <= 0) {
        return { ok: false, status: 403, error: "会员已过期且免费次数不足，请购买会员" };
      }
    }
  }

  return { ok: true, status: 200 };
}

// ============================================================
// 更新配额与记录日志
// ============================================================
async function updateQuotaAndLog(
  userId: string,
  message: string,
  botReply: string,
  quota: any
) {
  const today = new Date().toISOString().split("T")[0];

  // 构建更新对象
  const updates: any = {
    daily_used: quota.daily_used + 1,
    total_used: (quota.total_used || 0) + 1,  // 新增：累计次数+1
    last_request_at: new Date().toISOString(),
  };

  // 如果是跨天重置的情况，也需要更新 daily_reset_date
  if (quota.daily_reset_date !== today) {
    updates.daily_reset_date = today;
    updates.daily_used = 1; // 重置后从 1 开始计数
  }

  // 免费用户消耗 remaining
  if (quota.membership === "free" && quota.remaining > 0) {
    updates.remaining = quota.remaining - 1;
  }

  // 会员过期后降级处理：如果过期了且 remaining 还有，也扣 remaining
  if (quota.membership !== "free" && quota.expires_at && new Date(quota.expires_at) < new Date()) {
    if (quota.remaining > 0) {
      updates.remaining = quota.remaining - 1;
    }
  }

  // 更新 user_quotas
  const { error: updateError } = await supabaseAdmin
    .from("user_quotas")
    .update(updates)
    .eq("user_id", userId);

  if (updateError) throw updateError;

  // 插入 chat_logs
  const { error: logError } = await supabaseAdmin.from("chat_logs").insert({
    user_id: userId,
    user_message: message,
    bot_reply: botReply,
    tokens_used: 0, // 扣子 API 不直接返回 token 数，暂记 0
  });

  if (logError) throw logError;

  // 返回更新后的配额（近似值）
  return {
    remaining: updates.remaining ?? quota.remaining,
    daily_used: updates.daily_used,
    total_used: updates.total_used,  // 新增
    membership: quota.membership,
  };
}

// ============================================================
// 主处理函数
// ============================================================
Deno.serve(async (req: Request) => {
  // 处理 CORS 预检
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // 仅接受 POST
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method Not Allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const body = await req.json();
    const { message, user_id, device_fp } = body;
    const clientIP = getClientIP(req);

    // 参数校验
    if (!message || typeof message !== "string") {
      return new Response(
        JSON.stringify({ error: "缺少 message 参数" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (!user_id || typeof user_id !== "string") {
      return new Response(
        JSON.stringify({ error: "缺少 user_id 参数" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. 获取用户配额
    const quota = await getOrCreateQuota(user_id, clientIP);

    // 2. 风控校验
    const riskCheck = await checkRiskControl(quota, message);
    if (!riskCheck.ok) {
      return new Response(
        JSON.stringify({ error: riskCheck.error }),
        { status: riskCheck.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. 获取扣子 Access Token
    const accessToken = await getCozeAccessToken();

    // 4. 调用扣子 Bot
    const botReply = await callCozeBot(accessToken, user_id, message);

    // 5. 更新配额与记录日志
    const updatedQuota = await updateQuotaAndLog(user_id, message, botReply, quota);

    // 6. 查询定价套餐，获取正确的 daily_limit
    const { data: plans } = await supabaseAdmin
      .from("pricing_plans")
      .select("*")
      .order("price", { ascending: true });

    const plan = plans?.find(p => p.plan === updatedQuota.membership);
    const dailyLimit = plan?.daily_limit || 3;

    // 7. 返回结果
    return new Response(
      JSON.stringify({
        reply: botReply,
        remaining: updatedQuota.remaining,
        membership: updatedQuota.membership,
        daily_used: updatedQuota.daily_used,
        total_used: updatedQuota.total_used,  // 用 updatedQuota 里的
        daily_limit: dailyLimit,
        expires_at: quota.expires_at,    // 新增
        plans: plans || [],
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("chat-with-bot error:", err);
    if (err.message?.startsWith("RATE_LIMITED:")) {
      return new Response(
        JSON.stringify({ error: err.message.replace("RATE_LIMITED:", "") }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({ error: err.message || "Internal Server Error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
